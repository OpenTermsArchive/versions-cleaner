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
  logger.info('Retrieving snapshots...');
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

      const DECISION_BYPASS = 'Bypass: Decide later';
      const DECISION_RETRY = 'Retry: Declaration updated';

      const DECISION_SNAPSHOT_DATE = 'Show: Snapshot date';
      const DECISION_SNAPSHOT_DATA = 'Show: Snapshot data';
      const DECISION_SNAPSHOT = 'Show: HTML snapshot';
      const DECISION_DECLARATION = 'Show: Current declaration used';

      const DECISION_SKIP = 'Skip: Content of this snapshot is unprocessable';
      const DECISION_SKIP_CONTENT = 'Define content: Skip when content within selector is found';
      const DECISION_SKIP_SELECTOR = 'Define selector: Skip when this selector is found';
      const DECISION_SKIP_MISSING_SELECTOR = 'Define selector: Skip when this selector is NOT found';

      const DECISION_UPDATE = 'Update: Add entry in history. ⚠️  Declaration should still be fixed';

      const { decision } = await inquirer.prompt([{
        message,
        type: 'list',
        pageSize: 20,
        choices: [
          new inquirer.Separator('Decide'),
          ...(version ? [DECISION_KEEP] : []),
          DECISION_BYPASS,
          DECISION_RETRY,
          new inquirer.Separator('Analyze'),
          DECISION_SNAPSHOT_DATE,
          DECISION_SNAPSHOT_DATA,
          DECISION_SNAPSHOT,
          DECISION_DECLARATION,
          new inquirer.Separator('Skip'),
          DECISION_SKIP,
          DECISION_SKIP_CONTENT,
          DECISION_SKIP_SELECTOR,
          DECISION_SKIP_MISSING_SELECTOR,
          new inquirer.Separator('Update'),
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
      const { version, diffString, diffArgs, first, record, skipVersion, skipSnapshot, waitForAllPages, page, nbPages } = processedSnapshot;

      if (skipSnapshot) {
        logger.debug(`    ↳ Skipped snapshot: ${skipSnapshot}`);

        return;
      }

      if (waitForAllPages) {
        logger.debug(`    ↳ Wait for all pages to generate version: ${page}/${nbPages}`);

        return;
      }

      if (skipVersion) {
        logger.debug(`    ↳ Skipped version: ${skipVersion}`);

        return;
      }

      console.log(first ? colors.green(version) : diffString);

      if (diffArgs) {
        logger.debug('Generated with the following command');
        logger.debug(`git diff ${diffArgs.map(arg => arg.replace(' ', '\\ ')).join(' ')}`);
      }

      if (options.interactive) {
        await pickActionForSnapshot(`A new version is available for "${serviceId} - ${documentType}", is it valid?`, { version });
      }

      const { id } = await versionsCleaner.saveVersion(record);

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
        await pickActionForSnapshot(`A version can not be created from the snapshot of "${serviceId} - ${documentType}". What do you want to do?`, { filteredSnapshotContent });
      }
    }
  }

  console.time('Total execution time');

  let index = 1;
  const previousValidUntil = {};
  const iterateOptions = {};
  
  const progress = await versionsCleaner.getProgress();

  if (progress?.snapshotId) {
    const answer = await inquirer.prompt({
      type: 'list',
      message: `Would you like to resume the previous run from ${progress.date} at snapshot ID "${progress.snapshotId}"?`,
      name: 'resume',
      choices: [{ name: 'Yes, resume previous run', value: true }, { name: 'No, reset the progress and restart from the beginning', value: false }],
    });

    if (answer.resume) {
      logger.info('Resuming from snapshot', progress.snapshotId);
      iterateOptions.from = progress.snapshotId;
      index = progress.index;
    } else {
      await versionsCleaner.resetProgress();
      await versionsCleaner.resetTargetVersions();
    } 
  } else {
    await versionsCleaner.resetTargetVersions();
  }

  for await (const snapshot of versionsCleaner.iterateSnapshots(iterateOptions)) {
    const firstOfType = !(previousValidUntil && previousValidUntil[snapshot.serviceId] && previousValidUntil[snapshot.serviceId][snapshot.documentType]);

    previousValidUntil[snapshot.serviceId] = previousValidUntil[snapshot.serviceId] || {};
    previousValidUntil[snapshot.serviceId][snapshot.documentType] = previousValidUntil[snapshot.serviceId][snapshot.documentType] || snapshot.fetchDate.toISOString();

    const { validUntil } = versionsCleaner.getDocumentDeclarationFromSnapshot(snapshot) || {};

    logger.debug(colors.white(`${index}`.padStart(5, ' ')), '/', versionsCleaner.nbSnapshotsToProcess, colors.white(snapshot.serviceId), '-', colors.white(snapshot.documentType), '  ', 'Snapshot', snapshot.id, 'fetched at', snapshot.fetchDate.toISOString(), 'valid until', validUntil || 'now');
    await handleSnapshot(snapshot, { previousValidUntil, first: firstOfType });

    index++;
    previousValidUntil[snapshot.serviceId][snapshot.documentType] = snapshot.fetchDate.toISOString();

    if (index % 10 === 0) {
      console.log(`The script uses approximately ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} / ${Math.round((process.memoryUsage().heapTotal / 1024 / 1024) * 100) / 100} MB`);
    }

    await versionsCleaner.saveProgress(snapshot.id, index);
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
      logger.warn("Don't forget to commit the changes in the declarations repo");
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
