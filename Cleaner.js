import fs from 'fs';
import path from 'path';
import jsdom from 'jsdom';

const DEFAULT_CONTENT = {
  documents: {},
  documentTypes: { },
};

const { JSDOM } = jsdom;
export default class Cleaner {
  constructor(baseDir, filename = 'index.json') {
    this.baseDir = baseDir;
    this.filename = filename;
    this.filePath = path.join(baseDir, filename);
    fs.mkdir(baseDir, { recursive: true }, () => {
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, `${JSON.stringify(DEFAULT_CONTENT, null, 2)}\n`);
      }
    });
  }

  getRules() {
    if (!this.rules) {
      this.rules = JSON.parse(fs.readFileSync(this.filePath).toString());
    }

    return this.rules;
  }

  update(newRules) {
    this.rules = newRules;
    fs.writeFileSync(this.filePath, `${JSON.stringify(newRules, null, 2)}\n`);
  }

  updateDocument(serviceId, documentType, field, value) {
    const cleaningRules = this.getRules();
    const service = cleaningRules.documents[serviceId] || {};
    const document = service[documentType] || {};

    let updatedValue;

    if (field == 'skipContent') {
      updatedValue = { ...document[field] || {}, ...value };
    } else if ([ 'skipCommit', 'skipSelector', 'skipMissingSelector' ].includes(field)) {
      updatedValue = [ ...document[field] || [], value ];
    } else if (field == 'done') {
      updatedValue = value;
    }

    cleaningRules.documents = {
      ...cleaningRules.documents,
      [serviceId]: {
        ...service,
        [documentType]: {
          ...document,
          [field]: updatedValue,
        },
      },
    };
    // logger.debug(`${value} appended to ${field}`);
    this.update(cleaningRules);
  }

  getSnapshotIdsToSkip(serviceId, documentType) {
    const snapshotsIds = Object.entries(this.getRules().documents)
      .filter(([cleaningServiceId]) => [ '*', serviceId ].includes(cleaningServiceId))
      .map(([ , cleaningDocumentTypes ]) => Object.entries(cleaningDocumentTypes)
        .filter(([cleaningDocumentType]) => [ '*', documentType ].includes(cleaningDocumentType))
        .map(([ , { skipCommit }]) => skipCommit)
        .filter(skippedCommit => !!skippedCommit)
        .flat()).flat();

    return snapshotsIds;
  }

  getDocumentRules(serviceId, documentType) {
    const documentRules = (this.getRules().documents[serviceId] || {})[documentType];

    const contentsToSkip = (documentRules && documentRules.skipContent) || {};
    const selectorsToSkip = (documentRules && documentRules.skipSelector) || [];
    const missingRequiredSelectors = (documentRules && documentRules.skipIfMissingSelector) || [];

    return {
      contentsToSkip,
      selectorsToSkip,
      missingRequiredSelectors,
    };
  }

  getDocumentTypesRules() {
    return this.getRules().documentTypes || {};
  }

  isDocumentDone(serviceId, documentType) {
    const rules = this.getRules();

    return rules && rules.documents[serviceId] && rules.documents[serviceId][documentType] && rules.documents[serviceId][documentType].done;
  }

  async initializeSnapshotContentToSkip(serviceId, documentType, repository) {
    const snapshotsIds = this.getSnapshotIdsToSkip(serviceId, documentType);
  
    return Promise.all(snapshotsIds.map(async snapshotsId => {
      const { content, mimeType } = await repository.findById(snapshotsId);
  
      return filter({ pageDeclaration: DeclarationUtils.genericPageDeclaration, content, mimeType });
    }));
  }

  checkIfSnapshotShouldBeSkipped(snapshot, pageDeclaration) {
    const { serviceId, documentType } = snapshot;
  
    const { contentsToSkip, selectorsToSkip, missingRequiredSelectors } = this.getDocumentRules(serviceId, documentType);
  
    if (!(contentsToSkip || selectorsToSkip || missingRequiredSelectors)) {
      return { shouldSkip: false };
    }
  
    const { window: { document: webPageDOM } } = new JSDOM(snapshot.content, { url: pageDeclaration.location, virtualConsole: new jsdom.VirtualConsole() });
  
    const selectorToSkip = selectorsToSkip && selectorsToSkip.find(selector => webPageDOM.querySelectorAll(selector).length);
    const missingRequiredSelector = missingRequiredSelectors && missingRequiredSelectors.find(selector => !webPageDOM.querySelectorAll(selector).length);
    const contentToSkip = contentsToSkip && Object.entries(contentsToSkip).find(([ key, value ]) => webPageDOM.querySelector(key)?.innerHTML == value);
  
    if (!(selectorToSkip || missingRequiredSelector || contentToSkip)) {
      return { shouldSkip: false };
    }
  
    let reason;
  
    if (selectorToSkip) {
      reason = `its content matches a selector to skip: "${selectorToSkip}"`;
    }
  
    if (missingRequiredSelector) {
      reason = `its content does not match a required selector: "${missingRequiredSelector}"`;
    }
  
    if (contentToSkip) {
      reason = `its content matches a content to skip: ${contentToSkip}`;
    }
  
    return {
      shouldSkip: true,
      reason,
    };
  }
}
