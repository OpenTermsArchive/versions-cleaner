import fs from 'fs';
import fsPromise from 'fs/promises';
import path from 'path';

import RepositoryFactory from '@opentermsarchive/engine/repository-factory';
import config from 'config';

export default class VersionsOutput {
  constructor(baseDir, { snapshotRepoConfig, versionRepoConfig }) {
    this.skippedPath = path.join(baseDir, 'skipped');
    this.toCheckPath = path.join(baseDir, 'to-check');
    this.resultingVersionsPath = path.join(baseDir, 'resulting-versions');

    fs.mkdirSync(baseDir, { recursive: true });
    this.snapshotsRepository = RepositoryFactory.create(snapshotRepoConfig);
    this.sourceVersionsRepository = RepositoryFactory.create(versionRepoConfig);

    const targetRepositoryConfig = config.util.cloneDeep(versionRepoConfig);

    targetRepositoryConfig.git.path = this.resultingVersionsPath;
    this.targetVersionsRepository = RepositoryFactory.create(targetRepositoryConfig);
  }

  static generateSnapshotFilename(snapshot) {
    return `${snapshot.fetchDate.toISOString().replace(/\.\d{3}/, '').replace(/:|\./g, '-')}-${snapshot.id}.html`;
  }

  static async copyReadme(sourceRepository, targetRepository) {
    const sourceRepositoryReadmePath = `${sourceRepository.path}/README.md`;
    const targetRepositoryReadmePath = `${targetRepository.path}/README.md`;

    const [firstReadmeCommit] = await sourceRepository.git.log(['README.md']);

    if (!firstReadmeCommit) {
      console.warn(`No commit found for README in ${sourceRepository.path}`);

      return;
    }

    await fsPromise.copyFile(sourceRepositoryReadmePath, targetRepositoryReadmePath);
    await targetRepository.git.add(targetRepositoryReadmePath);
    await targetRepository.git.commit({
      filePath: targetRepositoryReadmePath,
      message: firstReadmeCommit.message,
      date: firstReadmeCommit.date,
    });
  }

  async initFolders(servicesDeclarations) {
    return Promise.all([ this.skippedPath, this.toCheckPath ].map(async folder =>
      Promise.all(Object.entries(servicesDeclarations).map(([ key, value ]) =>
        Promise.all(Object.keys(value.documents).map(documentName => {
          const folderPath = path.join(folder, key, documentName);

          if (fs.existsSync(folderPath)) {
            return;
          }

          return fs.mkdirSync(folderPath, { recursive: true });
        }))))));
  }

  async initRepositories() {
    await Promise.all([
      this.sourceVersionsRepository.initialize(),
      this.targetVersionsRepository.initialize(),
      this.snapshotsRepository.initialize(),
    ]);

    return {
      versionsRepository: this.targetVersionsRepository,
      snapshotsRepository: this.snapshotsRepository,
    };
  }

  async resetTargetVersionsRepository() {
    await this.targetVersionsRepository.removeAll();
    await VersionsOutput.copyReadme(this.sourceVersionsRepository, this.targetVersionsRepository);
  }

  async saveSkippedSnapshot(snapshot) {
    const snapshotPath = path.join(this.skippedPath, snapshot.serviceId, snapshot.documentType, VersionsOutput.generateSnapshotFilename(snapshot));

    await fsPromise.writeFile(snapshotPath, snapshot.content);

    return snapshotPath;
  }

  async saveToCheckSnapshot(snapshot) {
    const snapshotFolder = path.join(this.toCheckPath, snapshot.serviceId, snapshot.documentType);
    const snapshotPath = path.join(snapshotFolder, VersionsOutput.generateSnapshotFilename(snapshot));

    await fsPromise.writeFile(snapshotPath, snapshot.content);

    return snapshotPath;
  }

  async finalize() {
    /* eslint-disable no-await-in-loop */
    return Promise.all([ this.skippedPath, this.toCheckPath ].map(async folder => {
      const servicesDirectories = (await fsPromise.readdir(folder, { withFileTypes: true })).filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);

      for (const servicesDirectory of servicesDirectories) {
        const documentTypeDirectories = (await fsPromise.readdir(path.join(folder, servicesDirectory), { withFileTypes: true })).filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);

        for (const documentTypeDirectory of documentTypeDirectories) {
          const files = await fsPromise.readdir(path.join(folder, servicesDirectory, documentTypeDirectory));

          if (!files.length) {
            await fsPromise.rmdir(path.join(folder, servicesDirectory, documentTypeDirectory));
          }
        }

        const cleanedDocumentTypeDirectories = (await fsPromise.readdir(path.join(folder, servicesDirectory), { withFileTypes: true })).filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);

        if (!cleanedDocumentTypeDirectories.length) {
          await fsPromise.rmdir(path.join(folder, servicesDirectory));
        }
      }
    }));
    /* eslint-enable no-await-in-loop */
  }
}
