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

  function pickAction({ snapshot, params, documentDeclaration, serviceId, documentType, filteredSnapshotContent }) {
    return async function (message, { version }) {
      const toCheckSnapshotPath = await versionsCleaner.checkSnapshot(snapshot);

      const DECISION_KEEP = 'Keep: Version is fine';
      const DECISION_SKIP = 'Skip: Content of this snapshot is unprocessable';
      const DECISION_MAIN = version ? DECISION_KEEP : DECISION_SKIP;

      const DECISION_BYPASS = 'Bypass: Decide later';
      const DECISION_RETRY = 'Retry: Declaration updated';

      const DECISION_SNAPSHOT_DATE = 'Show: Snapshot date';
      const DECISION_SNAPSHOT_DATA = 'Show: Snapshot data';
      const DECISION_SNAPSHOT = 'Show: HTML snapshot';
      const DECISION_DECLARATION = 'Show: Current declaration used';

      const DECISION_SKIP_CONTENT = 'Update: Define content to be skipped';
      const DECISION_SKIP_SELECTOR = 'Update: Define selector to be skipped';
      const DECISION_SKIP_MISSING_SELECTOR = 'Update: Define selector that should not exist to be skipped';
      const DECISION_UPDATE = 'History: Add entry in history, I will fix the declaration';

      const { decision } = await inquirer.prompt([{
        message,
        type: 'list',
        pageSize: 20,
        choices: [
          new inquirer.Separator('Decide'),
          DECISION_MAIN,
          DECISION_BYPASS,
          DECISION_RETRY,
          new inquirer.Separator('Analyze'),
          DECISION_SNAPSHOT_DATE,
          DECISION_SNAPSHOT_DATA,
          DECISION_SNAPSHOT,
          DECISION_DECLARATION,
          new inquirer.Separator('Update'),
          DECISION_SKIP_CONTENT,
          DECISION_SKIP_SELECTOR,
          DECISION_SKIP_MISSING_SELECTOR,
          DECISION_UPDATE,
        ],
        name: 'decision',
      }]);

      if ([ DECISION_KEEP, DECISION_BYPASS ].includes(decision)) {
        // Pass to next snapshot
      }

      if (decision == DECISION_SKIP) {
        snapshotContentToSkip.push(filteredSnapshotContent);
        versionsCleaner.skipCommit({ serviceId, documentType, snapshotId: snapshot.id });
        // Pass to next snapshot
      }

      if (decision == DECISION_RETRY) {
        logger.debug('Reloading declarations…');
        await versionsCleaner.loadHistory();

        return handleSnapshot(snapshot, params);
      }

      if (decision == DECISION_SNAPSHOT_DATE) {
        logger.info('');
        logger.info(snapshot.fetchDate);
        logger.info('');
        await inquirer.prompt({ type: 'confirm', name: 'Click to continue' });

        return handleSnapshot(snapshot, params);
      }

      if (decision == DECISION_SNAPSHOT_DATA) {
        logger.info(snapshot);
        await inquirer.prompt({ type: 'confirm', name: 'Click to continue' });

        return handleSnapshot(snapshot, params);
      }

      if (decision == DECISION_SNAPSHOT) {
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

      if (decision == DECISION_DECLARATION) {
        logger.info(JSON.stringify(VersionsCleaner.getDeclarationAsJSON(documentDeclaration), null, 2));
        await inquirer.prompt({ type: 'confirm', name: 'Click to continue' });

        return handleSnapshot(snapshot, params);
      }

      if (decision == DECISION_SKIP_CONTENT) {
        const { skipContentSelector } = await inquirer.prompt({ type: 'input', name: 'skipContentSelector', message: 'CSS selector content will be selected from:' });
        const { skipContentValue } = await inquirer.prompt({ type: 'input', name: 'skipContentValue', message: 'innerHTML which, if exactly the same as the content of the selector above, will have the snapshot skipped:' });

        snapshotContentToSkip.push(version);
        versionsCleaner.skipContent({ serviceId, documentType, selector: skipContentSelector, value: skipContentValue });

        return handleSnapshot(snapshot, params);
      }
      if (decision == DECISION_SKIP_SELECTOR) {
        const { skipSelector } = await inquirer.prompt({ type: 'input', name: 'skipSelector', message: 'CSS selector which, if present in the snasphot, will have it skipped:' });

        versionsCleaner.skipSelector({ serviceId, documentType, selector: skipSelector });

        return handleSnapshot(snapshot, params);
      }

      if (decision == DECISION_SKIP_MISSING_SELECTOR) {
        const { skipMissingSelector } = await inquirer.prompt({ type: 'input', name: 'skipMissingSelector', message: 'CSS selector which, if present in the snasphot, will have it skipped' });

        versionsCleaner.skipMissingSelector({ serviceId, documentType, selector: skipMissingSelector });

        return handleSnapshot(snapshot, params);
      }

      if (decision == DECISION_UPDATE) {
        versionsCleaner.updateHistory({ serviceId, documentType, documentDeclaration, previousValidUntil: params.previousValidUntil });

        logger.warn('History has been updated, you now need to fix the current declaration');

        return handleSnapshot(snapshot, params);
      }
    };
  }

  async function handleSnapshot(originalSnapshot, params) {
    const snapshot = versionsCleaner.processSnapshotDocumentType(originalSnapshot);
    const { serviceId, documentType } = snapshot;
    const documentDeclaration = versionsCleaner.getDocumentDeclarationFromSnapshot(snapshot);
    const filteredSnapshotContent = await VersionsCleaner.getSnapshotFilteredContent(snapshot);

    const pickActionForSnapshot = pickAction({ snapshot, params, documentDeclaration, serviceId, documentType, filteredSnapshotContent });

    try {
      const processedSnapshot = await versionsCleaner.processSnapshot(snapshot);
      const { version, diffString, diffArgs, record, skipVersion, skipSnapshot } = processedSnapshot;

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

      if (options.interactive) {
        await pickActionForSnapshot('A new version is available, is it valid?', { version });
      }

      const { id } = await versionsCleaner.saveRecord(record);

      logger.info(`    ↳ Generated new version: ${id}`);
    } catch (error) {
      if (!(error instanceof InaccessibleContentError)) {
        throw error;
      }

      if (snapshotContentToSkip.find(contentToSkip => contentToSkip == filteredSnapshotContent)) {
        logger.debug('    ↳ Skipped: snapshot content is identical to one already skipped');

        return;
      }

      logger.error('    ↳ An error occured while filtering:', error.message);

      if (options.interactive) {
        await pickActionForSnapshot('A version can not be created from this snapshot. What do you want to do?', { filteredSnapshotContent });
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
      logger.info(`git add "declarations/${options.serviceId}*"`);
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
  const choices = (await VersionsCleaner.getServiceDocumentTypes()).map(({ serviceId, documentType, isDone }) => ({ name: `${isDone ? '✅' : '❌'} ${serviceId} ${documentType}`, value: { serviceId, documentType, isDone } }));
  const defaultChoice = choices.findIndex(({ value }) => !value.isDone);

  const { serviceToClean } = await inquirer.prompt([{
    message: 'Choose a document to clean',
    type: 'list',
    pageSize: 20,
    default: defaultChoice,
    choices,
    name: 'serviceToClean',
  }]);

  await cleanVersions({ ...serviceToClean, interactive: true });
} else {
  await cleanVersions(programOptions);
}
