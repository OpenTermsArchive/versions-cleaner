import fs from 'fs/promises';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';

import { InaccessibleContentError } from '@opentermsarchive/engine/errors';
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

  async saveProgression(snapshotId, index) {
    return this.declarationsCleaner.saveProgression(snapshotId, index);
  }

  async getProgression() {
    return this.declarationsCleaner.getProgression();
  }

  async resetProgression() {
    return this.declarationsCleaner.resetProgression();
  }

  async resetTargetVersions() {
    return this.versionsOutput.resetTargetVersionsRepository();
  }

  /** FIXME Copied from Archivist */
  static async generateDocumentFilteredContent(snapshots, pages) {
    return (
      await Promise.all(pages.map(async pageDeclaration => {
        const { content, mimeType } = snapshots.find(({ pageId }) => pageId === pageDeclaration.id) || snapshots[0];

        return filter({ content, mimeType, pageDeclaration });
      }))
    ).join('\n\n');
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

  async init(options = {}) {
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
    this.multipageBuffer = {};
  }

  isDocumentDeclarationAlreadyDone() {
    return declarationsCleaner.isDocumentDone(this.serviceId, this.documentType);
  }

  processSnapshotDocumentType(snapshot) {
    snapshot.documentType = this.declarationsCleaner.getDocumentTypesRules()[snapshot.documentType] || snapshot.documentType;

    return snapshot;
  }

  async getSnapshotContentsToSkip() {
    return Promise.all(declarationsCleaner.getSnapshotIdsToSkip(this.serviceId, this.documentType).map(async snapshotId => {
      try {
        const snapshot = await this.snapshotsRepository.findById(snapshotId);

        return VersionsCleaner.getSnapshotFilteredContent(snapshot);
      } catch (e) {
        console.error(`Snapshot ${snapshotId} not found`);

        return '';
      }
    }));
  }

  async checkIfVersionShouldBeSkipped(serviceId, documentType, version) {
    const tmpFilePath = path.join(os.tmpdir(), 'regenerated-version.md');

    await fs.writeFile(tmpFilePath, version);

    const diffArgs = [ '--minimal', '--color=always', '--color-moved=zebra', `${serviceId}/${documentType}.md`, tmpFilePath ];
    let firstVersion = false;
    const diffString = await this.versionsRepository.git.diff(diffArgs).catch(async error => {
      if (error.message.includes('Could not access')) {
        // File does not yet exist
        firstVersion = true;

        return;
      }

      throw error;
    });

    if (firstVersion) {
      return { shouldSkip: false, first: true, diffString: version, diffArgs };
    }

    if (!diffString) {
      return {
        shouldSkip: true,
        reason: 'version is identical to previous',
      };
    }

    return { shouldSkip: false, diffString, diffArgs };
  }

  getDocumentDeclarationFromSnapshot(snapshot) {
    const serviceDeclaration = this.servicesDeclarations[snapshot.serviceId];

    if (!serviceDeclaration) {
      return null;
    }

    return serviceDeclaration.getDocumentDeclaration(snapshot.documentType, snapshot.fetchDate);
  }

  async processSnapshot(snapshot) {
    const documentDeclaration = this.getDocumentDeclarationFromSnapshot(snapshot);

    if (!documentDeclaration) {
      // The document declaration does not exist anymore
      // As no history file remains, it means that the snapshots were not meant
      // to be recorded at all, so just skip them and don't mark anything in the cleaning file

      return ({ snapshot, skipSnapshot: 'Declaration does not exist' });
    }

    const { pages: pageDeclarations } = documentDeclaration;
    const { serviceId, documentType } = snapshot;

    const pageDeclaration = snapshot.pageId ? pageDeclarations.find(({ id }) => snapshot.pageId === id) : pageDeclarations[0];

    if (!pageDeclaration) {
      throw new InaccessibleContentError('Page declaration not found. Multi page snapshot seems to be used with a one page declaration');
    }

    const { shouldSkip: shouldSkipSnapshot, reason: reasonShouldSkipSnapshot } = declarationsCleaner.checkIfSnapshotShouldBeSkipped(snapshot, pageDeclaration);

    if (shouldSkipSnapshot) {
      await this.skipSnapshot(snapshot);

      return ({ snapshot, skipSnapshot: shouldSkipSnapshot && reasonShouldSkipSnapshot });
    }

    this.multipageBuffer[serviceId] = this.multipageBuffer[serviceId] || {};
    this.multipageBuffer[serviceId][documentType] = this.multipageBuffer[serviceId][documentType] || { snapshots: [] };
    this.multipageBuffer[serviceId][documentType].snapshots.push(snapshot);

    const { snapshots } = this.multipageBuffer[serviceId][documentType];

    const page = snapshots.length;
    const nbPages = pageDeclarations.length;

    if (page < nbPages) {
      return { snapshot, waitForAllPages: true, nbPages, page };
    }

    const version = await VersionsCleaner.generateDocumentFilteredContent(snapshots, pageDeclarations);

    const { shouldSkip: shouldSkipVersion, reason: reasonShouldSkipVersion, diffString, diffArgs, first } = await this.checkIfVersionShouldBeSkipped(serviceId, documentType, version);

    const record = new Record({
      content: version,
      snapshotIds: snapshots.map(({ id }) => id),
      serviceId,
      documentType,
      fetchDate: snapshot.fetchDate,
      mimeType: 'text/markdown',
    });

    delete this.multipageBuffer[snapshot.serviceId][snapshot.documentType];

    return { snapshot, version, diffString, first, diffArgs, record, skipVersion: shouldSkipVersion && reasonShouldSkipVersion };
  }

  iterateSnapshots(options = {}) {
    const optionsAsArray = [];

    if (options.from) {
      optionsAsArray.push(`${options.from}..HEAD`);
      optionsAsArray.push('--');
    }

    return this.snapshotsRepository.iterate([
      ...optionsAsArray,
      `${this.serviceId}/${this.documentType}.*`,
      `${this.serviceId}/${this.documentType} #*.*`, // For Multi page documents
    ]);
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
