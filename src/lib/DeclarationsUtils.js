import fs from 'fs';
import path from 'path';

import DeepDiff from 'deep-diff';

const removeUndefinedFields = obj => Object.keys(obj).forEach(key => obj[key] === undefined && delete obj[key]);

export default class DeclarationUtils {
  static genericPageDeclaration = {
    location: 'http://service.example',
    contentSelectors: 'html',
    filters: [document => {
      document.querySelectorAll('a').forEach(el => {
        const url = new URL(el.getAttribute('href'), document.location);

        url.search = '';
        el.setAttribute('href', url.toString());
      });
    }],
  };

  static pageToJSON = page => ({
    fetch: page.location,
    select: page.contentSelectors,
    remove: page.noiseSelectors,
    filter: page.filters ? page.filters.map(filter => filter.name) : undefined,
    executeClientScripts: page.executeClientScripts,
  });

  static declarationToJSON(declaration) {
    return ({
      name: declaration.service.name,
      documents: {
        [declaration.type]: declaration.isMultiPage
          ? { combine: declaration.pages.map(page => DeclarationUtils.pageToJSON(page)) }
          : DeclarationUtils.pageToJSON(declaration.pages[0]),
      },
    });
  }

  constructor(baseDir, { logger }) {
    this.baseDir = baseDir;
    this.logger = logger;
  }

  logDeclaration(declaration) {
    this.logger.info(JSON.stringify(DeclarationUtils.declarationToJSON(declaration), null, 2));
  }

  async updateHistory(serviceId, documentType, documentDeclaration, { validUntil }) {
    const historyFullPath = path.join(this.baseDir, `${serviceId}.history.json`);

    if (!fs.existsSync(historyFullPath)) {
      fs.writeFileSync(historyFullPath, `${JSON.stringify({ [documentType]: [] }, null, 2)}\n`);
    }

    const currentJSONDeclaration = { ...DeclarationUtils.declarationToJSON(documentDeclaration).documents[documentType] };

    const existingHistory = JSON.parse(fs.readFileSync(historyFullPath).toString());

    const historyEntries = existingHistory[documentType] || [];

    let entryAlreadyExists = false;

    existingHistory[documentType] = [...existingHistory[documentType] || []];

    historyEntries.map(({ validUntil, ...historyEntry }) => {
      const diff = DeepDiff.diff(removeUndefinedFields(historyEntry), removeUndefinedFields(currentJSONDeclaration));

      if (diff) {
        return { ...historyEntry, validUntil };
      }

      entryAlreadyExists = true;
      this.logger.info(`History entry is already present, updating validUntil to ${validUntil}`);

      return { ...historyEntry, validUntil };
    });

    if (entryAlreadyExists) {
      existingHistory[documentType] = historyEntries;
    } else {
      this.logger.info('History entry does not exist, creating one');
      existingHistory[documentType] = [ ...historyEntries, { ...currentJSONDeclaration, validUntil }];
    }

    fs.writeFileSync(historyFullPath, `${JSON.stringify(existingHistory, null, 2)}\n`);
  }
}
