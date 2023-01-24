import { InaccessibleContentError } from '@opentermsarchive/engine/errors';
import { program } from 'commander';
import inquirer from 'inquirer';

import VersionsCleaner from './lib/VersionsCleaner.js';
import logger, { colors, logColors } from './logger/index.js';

program
  .name('regenerate')
  .description('Cleanup services declarations and regenerate versions history')
  .version('0.0.1');

program
  .option('-l, --list', 'lists all services to be handled')
  .option('-s, --serviceId [serviceId]', 'service ID of service to handle')
  .option('-d, --documentType [documentType]', 'document type to handle')
  .option('-i, --interactive', 'Enable interactive mode to validate each version and choose if snapshot should be skipped');

program.parse(process.argv);
const programOptions = program.opts();

const cleanVersions = async options => {
  logger.info('options', options);

  const versionsCleaner = new VersionsCleaner({ serviceId: options.serviceId || '*', documentType: options.documentType || '*', logger });

  await versionsCleaner.init();

  logger.debug('Number of snapshots in the repository', logColors.info(versionsCleaner.nbSnapshots));
  if (versionsCleaner.hasFilter) {
    logger.debug('Number of snapshots for the specified service', logColors.info((versionsCleaner.nbSnapshotsToProcess)));
  }

  if (versionsCleaner.hasDocumentType && versionsCleaner.isDocumentDeclarationAlreadyDone() && options.interactive) {
    logger.error(`${options.serviceId} - ${options.documentType} has already been marked as done. If you're sure of what you're doing, manually remove "done" from the cleaning file`);
    process.exit();
  }

  const snapshotContentToSkip = await versionsCleaner.getSnapshotContentsToSkip();

  async function handleSnapshot(originalSnapshot, params) {
    const snapshot = versionsCleaner.processSnapshotDocumentType(originalSnapshot);

    const { serviceId, documentType } = snapshot;

    try {
      const { documentDeclaration, version, diffString, diffArgs, record, skipVersion, skipSnapshot } = await versionsCleaner.processSnapshot(snapshot);

      if (skipSnapshot) {
        logger.debug(`    ↳ Skipped snapshot: ${skipSnapshot}`);

        return;
      }
      if (skipVersion && params.index > 1) {
        logger.debug(`    ↳ Skipped version: ${skipVersion}`);

        return;
      }

      console.log(params.index === 1 ? colors.green(version) : diffString);

      if (diffArgs) {
        logger.debug('Generated with the following command');
        logger.debug(`git diff ${diffArgs.map(arg => arg.replace(' ', '\\ ')).join(' ')}`);
      }

      const toCheckSnapshotPath = await versionsCleaner.checkSnapshot(snapshot);

      if (options.interactive) {
        const DECISION_VERSION_KEEP = 'Keep: The version is fine';
        const DECISION_VERSION_SKIP_CONTENT = 'Skip: Define content to be skipped';
        const DECISION_VERSION_SKIP_SELECTOR = 'Skip: Define selector to be skipped';
        const DECISION_VERSION_SKIP_MISSING_SELECTOR = 'Skip: define selector that should not exist to be skipped';
        const DECISION_VERSION_SNAPSHOT = 'Show: Display HTML snapshot';
        const DECISION_VERSION_DECLARATION = 'Show: Display current declaration used';
        const DECISION_VERSION_UPDATE = 'History: Add entry in history, I will fix the declaration';
        const DECISION_VERSION_RETRY = 'Retry: I updated the declaration';

        const { decision } = await inquirer.prompt([{
          message: 'A new version is available, is it valid?',
          type: 'list',
          pageSize: 20,
          choices: [
            new inquirer.Separator('Decide'), DECISION_VERSION_KEEP, DECISION_VERSION_RETRY, new inquirer.Separator('Analyze'), DECISION_VERSION_SNAPSHOT, DECISION_VERSION_DECLARATION, new inquirer.Separator('Update'), DECISION_VERSION_SKIP_CONTENT, DECISION_VERSION_SKIP_SELECTOR, DECISION_VERSION_SKIP_MISSING_SELECTOR, DECISION_VERSION_UPDATE ],
          name: 'decision',
        }]);

        if (decision == DECISION_VERSION_KEEP) {
          // Pass to next snapshot
        }

        if (decision == DECISION_VERSION_RETRY) {
          logger.debug('Reloading declarations…');
          await versionsCleaner.loadHistory();

          return handleSnapshot(snapshot, params);
        }

        if (decision == DECISION_VERSION_SNAPSHOT) {
          logger.info('');
          logger.info('- Open it in your IDE');
          logger.info(`open -a "Google Chrome" "${toCheckSnapshotPath}"`);
          logger.info('');
          logger.info('- Or see it online');
          logger.info(versionsCleaner.getSnapshotCommitURL(snapshot.id));
          await inquirer.prompt({ type: 'confirm', name: 'Click on the link above to see the snapshot and then click on continue' });

          return handleSnapshot(snapshot, params);
        }

        if (decision == DECISION_VERSION_DECLARATION) {
          logger.info(JSON.stringify(VersionsCleaner.getDeclarationAsJSON(documentDeclaration), null, 2));
          await inquirer.prompt({ type: 'confirm', name: 'Click to continue' });

          return handleSnapshot(snapshot, params);
        }

        if (decision == DECISION_VERSION_SKIP_CONTENT) {
          const { skipContentSelector } = await inquirer.prompt({ type: 'input', name: 'skipContentSelector', message: 'CSS selector content will be selected from:' });
          const { skipContentValue } = await inquirer.prompt({ type: 'input', name: 'skipContentValue', message: 'innerHTML which, if exactly the same as the content of the selector above, will have the snapshot skipped:' });

          snapshotContentToSkip.push(version);
          versionsCleaner.skipContent({ serviceId, documentType, selector: skipContentSelector, value: skipContentValue });

          return handleSnapshot(snapshot, params);
        }
        if (decision == DECISION_VERSION_SKIP_SELECTOR) {
          const { skipSelector } = await inquirer.prompt({ type: 'input', name: 'skipSelector', message: 'CSS selector which, if present in the snasphot, will have it skipped:' });

          versionsCleaner.skipSelector({ serviceId, documentType, selector: skipSelector });

          return handleSnapshot(snapshot, params);
        }

        if (decision == DECISION_VERSION_SKIP_MISSING_SELECTOR) {
          const { skipMissingSelector } = await inquirer.prompt({ type: 'input', name: 'skipMissingSelector', message: 'CSS selector which, if present in the snasphot, will have it skipped' });

          versionsCleaner.skipMissingSelector({ serviceId, documentType, selector: skipMissingSelector });

          return handleSnapshot(snapshot, params);
        }

        if (decision == DECISION_VERSION_UPDATE) {
          versionsCleaner.updateHistory({ serviceId, documentType, documentDeclaration, validUntil: params.previousValidUntil });

          logger.warn('History has been updated, you now need to fix the current declaration');

          return handleSnapshot(snapshot, params);
        }
      }

      const { id } = await versionsCleaner.saveRecord(record);

      logger.info(`    ↳ Generated new version: ${id}`);
    } catch (error) {
      if (!(error instanceof InaccessibleContentError)) {
        throw error;
      }
      const documentDeclaration = versionsCleaner.getDocumentDeclarationFromSnapshot(snapshot);
      const filteredSnapshotContent = await VersionsCleaner.getSnapshotFilteredContent(snapshot);

      if (snapshotContentToSkip.find(contentToSkip => contentToSkip == filteredSnapshotContent)) {
        logger.debug('    ↳ Skipped: snapshot content is identical to one already skipped');

        return;
      }

      logger.error('    ↳ An error occured while filtering:', error.message);

      if (options.interactive) {
        const toCheckSnapshotPath = await versionsCleaner.checkSnapshot(snapshot);

        const DECISION_ON_ERROR_BYPASS = 'Bypass: I don\'t know yet';
        const DECISION_ON_ERROR_SKIP = 'Skip: content of this snapshot is unprocessable';
        const DECISION_ON_ERROR_DECLARATION = 'Show: Display current declaration used';
        const DECISION_ON_ERROR_SNAPSHOT = 'Show: Display HTML snapshot';
        const DECISION_ON_ERROR_UPDATE = 'History: Add entry in history. I will fix the declaration';
        const DECISION_ON_ERROR_RETRY = 'Retry: I updated the declaration';

        const { decisionOnError } = await inquirer.prompt([{
          message: 'A version can not be created from this snapshot. What do you want to do?',
          type: 'list',
          pageSize: 20,
          choices: [
            new inquirer.Separator('Decide'), DECISION_ON_ERROR_BYPASS, DECISION_ON_ERROR_SKIP, new inquirer.Separator('Analyze'), DECISION_ON_ERROR_DECLARATION, DECISION_ON_ERROR_SNAPSHOT, new inquirer.Separator('Update'), DECISION_ON_ERROR_UPDATE, DECISION_ON_ERROR_RETRY ],
          name: 'decisionOnError',
        }]);

        if (decisionOnError == DECISION_ON_ERROR_RETRY) {
          logger.debug('Reloading declarations…');
          await versionsCleaner.loadHistory();

          return handleSnapshot(snapshot, params);
        }

        if (decisionOnError == DECISION_ON_ERROR_DECLARATION) {
          logger.info(JSON.stringify(VersionsCleaner.getDeclarationAsJSON(documentDeclaration), null, 2));
          await inquirer.prompt({ type: 'confirm', name: 'Click to continue' });

          return handleSnapshot(snapshot, params);
        }

        if (decisionOnError == DECISION_ON_ERROR_UPDATE) {
          versionsCleaner.updateHistory({ serviceId, documentType, documentDeclaration, validUntil: params.previousValidUntil });

          logger.warn('History has been updated, you now need to fix the current declaration');

          return handleSnapshot(snapshot, params);
        }

        if (decisionOnError == DECISION_ON_ERROR_SNAPSHOT) {
          const line = colors.grey(colors.underline(`${' '.repeat(process.stdout.columns)}`));

          console.log(`\n\n${line}\n${colors.cyan(filteredSnapshotContent)}\n${line}\n\n`);
          logger.info('');
          logger.info('- Open it in your IDE');
          logger.info(`open -a "Google Chrome" "${toCheckSnapshotPath}"`);
          logger.info('');
          logger.info('- Or see it online');
          logger.info(versionsCleaner.getSnapshotCommitURL(snapshot.id));
          await inquirer.prompt({ type: 'confirm', name: 'Click on the link above to see the snapshot and then click on continue' });

          return handleSnapshot(snapshot, params);
        }

        if (decisionOnError == DECISION_ON_ERROR_SKIP) {
          snapshotContentToSkip.push(filteredSnapshotContent);
          versionsCleaner.skipCommit({ serviceId, documentType, snapshotId: snapshot.id });
        }

        if (decisionOnError == DECISION_ON_ERROR_BYPASS) {
          // Pass to next snapshot
        }
      }
    }
  }

  console.time('Total execution time');

  let index = 1;
  let previousValidUntil = null;

  for await (const snapshot of versionsCleaner.iterateSnapshots()) {
    if (!previousValidUntil) {
      previousValidUntil = snapshot.fetchDate.toISOString();
    }
    const { validUntil } = versionsCleaner.getDocumentDeclarationFromSnapshot(snapshot);

    logger.debug(colors.white(`${index}`.padStart(5, ' ')), '/', versionsCleaner.nbSnapshotsToProcess, colors.white(snapshot.serviceId), '-', colors.white(snapshot.documentType), '  ', 'Snapshot', snapshot.id, 'fetched at', snapshot.fetchDate.toISOString(), 'valid until', validUntil || 'now');
    await handleSnapshot(snapshot, { index, previousValidUntil });

    index++;
    previousValidUntil = snapshot.fetchDate.toISOString();
  }

  console.timeEnd('Total execution time');

  if (versionsCleaner.hasDocumentType && options.interactive) {
    const DECISION_END_DONE = 'All is ok, mark it as done';
    const DECISION_END_RETRY = 'Restart in non interactive mode';
    const DECISION_END_QUIT = 'Quit';

    const { decisionEnd } = await inquirer.prompt([{
      message: 'All snapshots have been analyzed. What do you want to do?',
      type: 'list',
      pageSize: 20,
      choices: [
        DECISION_END_DONE, DECISION_END_RETRY, DECISION_END_QUIT ],
      name: 'decisionEnd',
    }]);

    if (decisionEnd == DECISION_END_DONE) {
      versionsCleaner.markAsDone({ serviceId: options.serviceId, documentType: options.documentType });
      logger.info(`${options.serviceId} - ${options.documentType} has been marked as done`);
      logger.warn("Don't forget to commit the changes");
      logger.info();
      logger.info(`git add declarations/${options.serviceId}*`);
      logger.info('git add cleaning/index.json');
      logger.info(`git commit -m "Clean ${options.serviceId} ${options.documentType}"`);
    }

    if (decisionEnd == DECISION_END_RETRY) {
      await cleanVersions({ serviceId: options.serviceId, documentType: options.documentType });
    }
    if (decisionEnd == DECISION_END_QUIT) {
      process.exit();
    }
  }

  await versionsCleaner.finalize();
};

if (programOptions.list) {
  const choices = (await VersionsCleaner.getServiceDocumentTypes()).map(({ serviceId, documentType, isDone }) => ({ name: `${isDone ? '✅' : '❌'} ${serviceId} ${documentType}`, value: { serviceId, documentType } }));

  const { serviceToClean } = await inquirer.prompt([{
    message: 'Choose a document to clean',
    type: 'list',
    pageSize: 20,
    choices,
    name: 'serviceToClean',
  }]);

  await cleanVersions({ ...serviceToClean, interactive: true });
} else {
  await cleanVersions(programOptions);
}
