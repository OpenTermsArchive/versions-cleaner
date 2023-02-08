import fs from 'fs/promises';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';

import filter from '@opentermsarchive/engine/filter';
import Record from '@opentermsarchive/engine/record';
import services from '@opentermsarchive/engine/services';
import config from 'config';

import DeclarationsCleaner from './DeclarationsCleaner.js';
import DeclarationsUtils from './DeclarationsUtils.js';
import VersionsOutput from './VersionsOutput.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DECLARATIONS_PATH = config.services.declarationsPath;
const CLEANING_FOLDER_PATH = path.join(DECLARATIONS_PATH, '../cleaning');
const VERSIONS_OUTPUT_PATH = path.resolve(__dirname, '../../output');

const declarationsCleaner = new DeclarationsCleaner(CLEANING_FOLDER_PATH);

export default class VersionsCleaner {
  static async getServiceDocumentTypes() {
    const servicesDeclarations = await services.loadWithHistory();

    return Object.entries(servicesDeclarations).map(([ serviceId, { documents }]) => Object.keys(documents).map(documentType => {
      const isDone = declarationsCleaner.isDocumentDone(serviceId, documentType);

      return { serviceId, documentType, isDone };
    })).flat().sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  }

  static getDeclarationAsJSON(declaration) {
    return DeclarationsUtils.declarationToJSON(declaration);
  }

  static getSnapshotRepositoryURL() {
    const declarationsRepoURL = config.get('services.repository');

    return declarationsRepoURL.replace('-declarations', '-snapshots').replace(/\.git$/, '');
  }

  static async getSnapshotFilteredContent(snapshot) {
    try {
      return await filter({ pageDeclaration: DeclarationsUtils.genericPageDeclaration, content: snapshot.content, mimeType: snapshot.mimeType });
    } catch (e) {
      return '';
    }
  }

  constructor({ serviceId, documentType, logger }) {
    this.serviceId = serviceId;
    this.documentType = documentType;
    this.hasFilter = serviceId != '*' || documentType != '*';
    this.hasDocumentType = serviceId != '*' && documentType != '*';
    this.versionsOutput = new VersionsOutput(VERSIONS_OUTPUT_PATH, { snapshotRepoConfig: config.recorder.snapshots.storage, versionRepoConfig: config.recorder.versions.storage });
    this.snapshotRepositoryURL = VersionsCleaner.getSnapshotRepositoryURL();
    this.declarationUtils = new DeclarationsUtils(DECLARATIONS_PATH, { logger });
    this.declarationsCleaner = declarationsCleaner;
    this.logger = logger;
  }

  async loadHistory() {
    this.servicesDeclarations = await services.loadWithHistory(this.serviceId != '*' ? [this.serviceId] : undefined);
  }

  async init() {
    await this.loadHistory();
    await this.versionsOutput.initFolders(this.servicesDeclarations);
    const { versionsRepository, snapshotsRepository } = await this.versionsOutput.initRepositories();

    this.versionsRepository = versionsRepository;
    this.snapshotsRepository = snapshotsRepository;
    this.nbSnapshots = await snapshotsRepository.count();

    const snapshots = (await snapshotsRepository.findAll())
      .filter(s =>
        (this.serviceId && this.serviceId != '*' ? s.serviceId == this.serviceId : true)
        && (this.documentType && this.documentType != '*' ? s.documentType == this.documentType : true));

    this.nbSnapshotsToProcess = snapshots.length;
    this.latestSnapshotDate = snapshots[snapshots.length - 1].fetchDate;
  }

  isDocumentDeclarationAlreadyDone() {
    return declarationsCleaner.isDocumentDone(this.serviceId, this.documentType);
  }

  processSnapshotDocumentType(snapshot) {
    snapshot.documentType = this.declarationsCleaner.getDocumentTypesRules()[snapshot.documentType] || snapshot.documentType;

    return snapshot;
  }

  async getSnapshotContentsToSkip() {
    return Promise.all(declarationsCleaner.getSnapshotIdsToSkip(this.serviceId, this.documentType).map(async snapshotsId => {
      const snapshot = await this.snapshotsRepository.findById(snapshotsId);

      return VersionsCleaner.getSnapshotFilteredContent(snapshot);
    }));
  }

  async checkIfVersionShouldBeSkipped(serviceId, documentType, version) {
    const tmpFilePath = path.join(os.tmpdir(), 'regenerated-version.md');

    await fs.writeFile(tmpFilePath, version);

    const diffArgs = [ '--minimal', '--color=always', '--color-moved=zebra', `${serviceId}/${documentType}.md`, tmpFilePath ];

    const diffString = await this.versionsRepository.git.diff(diffArgs).catch(async error => {
      if (!error.message.includes('Could not access')) {
        throw error;
      }
    });

    if (!diffString) {
      return {
        shouldSkip: true,
        reason: 'version is identical to previous',
      };
    }

    return { shouldSkip: false, diffString, diffArgs };
  }

  getDocumentDeclarationFromSnapshot(snapshot) {
    return this.servicesDeclarations[snapshot.serviceId].getDocumentDeclaration(snapshot.documentType, snapshot.fetchDate);
  }

  async processSnapshot(snapshot) {
    const documentDeclaration = this.getDocumentDeclarationFromSnapshot(snapshot);

    const { pages: pageDeclarations } = documentDeclaration;

    // FIXME This does not support multi page
    const pageDeclaration = pageDeclarations[0];

    const { shouldSkip: shouldSkipSnapshot, reason: reasonShouldSkipSnapshot } = declarationsCleaner.checkIfSnapshotShouldBeSkipped(snapshot, pageDeclaration);

    if (shouldSkipSnapshot) {
      await this.skipSnapshot(snapshot);

      return ({ snapshot, skipSnapshot: shouldSkipSnapshot && reasonShouldSkipSnapshot });
    }

    const version = await filter({
      pageDeclaration,
      content: snapshot.content,
      mimeType: snapshot.mimeType,
    });

    const record = new Record({
      content: version,
      serviceId: snapshot.serviceId,
      documentType: snapshot.documentType,
      snapshotId: snapshot.id,
      fetchDate: snapshot.fetchDate,
      mimeType: 'text/markdown',
    });

    const { shouldSkip: shouldSkipVersion, reason: reasonShouldSkipVersion, diffString, diffArgs } = await this.checkIfVersionShouldBeSkipped(snapshot.serviceId, snapshot.documentType, version);

    return { snapshot, version, diffString, diffArgs, record, skipVersion: shouldSkipVersion && reasonShouldSkipVersion };
  }

  iterateSnapshots() {
    return this.snapshotsRepository.iterate([`${this.serviceId}/${this.documentType}.*`]);
  }

  async checkSnapshot(snapshot) {
    return this.versionsOutput.saveToCheckSnapshot(snapshot);
  }

  async saveVersion(record) {
    return this.versionsRepository.save(record);
  }

  async skipSnapshot(snapshot) {
    return this.versionsOutput.saveSkippedSnapshot(snapshot);
  }

  skipContent({ serviceId, documentType, selector, value }) {
    this.declarationsCleaner.updateDocument(serviceId, documentType, 'skipContent', { [selector]: value });
  }

  skipSelector({ serviceId, documentType, selector }) {
    this.declarationsCleaner.updateDocument(serviceId, documentType, 'skipSelector', selector);
  }

  skipMissingSelector({ serviceId, documentType, selector }) {
    this.declarationsCleaner.updateDocument(serviceId, documentType, 'skipMissingSelector', selector);
  }

  skipCommit({ serviceId, documentType, snapshotId }) {
    this.declarationsCleaner.updateDocument(serviceId, documentType, 'skipCommit', snapshotId);
  }

  markAsDone({ serviceId, documentType }) {
    this.declarationsCleaner.updateDocument(serviceId, documentType, 'done', new Date());
  }

  updateHistory({ serviceId, documentType, documentDeclaration, previousValidUntil }) {
    this.declarationUtils.updateHistory(serviceId, documentType, documentDeclaration, { previousValidUntil });
  }

  getSnapshotCommitURL(commitId) {
    return `${this.snapshotRepositoryURL}/commit/${commitId}`;
  }

  async finalize() {
    await this.versionsOutput.finalize();
  }
}
