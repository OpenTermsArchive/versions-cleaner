# Versions Cleaner
**:warning: This script is an experimental proof of concept for versions history cleaning**

**It is using an unstable branch `[versions-cleaner](https://github.com/ambanum/OpenTermsArchive/tree/versions-cleaner)` of ambanum/OpenTermsArchive that exposes some needed core features**

Along the life of an instance, unsatisfactory versions of documents might be extracted from snapshots. For example, they might be changes unrelated to terms, or empty documents, or change language… Such unsatisfactory versions decrease the value of the dataset: it becomes impossible to measure the actual number of changes, for example.

Reviewing and cleaning the dataset entails correcting the history of declarations, identifying some snapshots to skip, and extracting new versions from the snapshots based on this information. In the end, the whole versions history will be rewritten and overwritten. The declarations will be completed. All the original snapshots are left unchanged and the previous state of the versions is still available, allowing auditability.

This script recreates a history of versions from existing snapshots and declarations, based on the current configuration.

It allows to review generated versions and correct services declarations if needed. It also allows to skip unexploitable snapshots (empty content, botwall, loginwall, cookiewall, server error, …) or unwanted snapshots when there is a blink and we want to skip one in the alternative (switch between mobile and desktop pages, switch between languages, …).

## Process

The script follow this process:

- Iterate on every snapshot
- Extract version
    - This will automatically erase refilters. Indeed, refilters are only historical artifacts: they correct a version that should not have been recorded as it was in the first place.
- If the version cannot be generated: 
    - If the snapshot is unexploitable, skip it. A snapshot is unexploitable if it does not contain the tracked document. We have encountered so far:
        - Empty content
        - Botwall
        - Loginwall
        - Cookiewall
        - Server error
        - **Exception:** if the provider is in a certain manner unable to provide the document to its expected audience, and not only to Open Terms Archive, this should be tracked (e.g. undergoing maintenance)
    - If the snapshot is exploitable, correct declaration. Potential reasons are:
        - Some selector is wrong. Usually, that means the history date for applying that selector is wrong (otherwise the declaration was wrong from the beginning). Take the `fetchDate` of the last snapshot that does not fail to generate a version as `validUntil`
- If the generated version markup differs significantly, remove changes that do not reflect a change in the document content itself.
    - We have encountered so far:
        - Switching list styles (ordered to unordered list)
        - Switching between mobile and desktop pages
        - Switching between geographic region-optimised layouts
        - Switching between languages (934bddb9cdf40e7c53b5c43d0db3dc393e2a2eb4)
        - Switching between different browser-optimised layouts
        - **Note**: these should happen less and less as:
            -  The Core is optimised to minimise such changes (single user agent)
            -  Deployment is optimised to minimise such changes (single well-known IP)
            -  Operations are optimised to minimise such changes (single process instead of parallel, decreasing the number of requests)
    - Known tactics, by order of preference:
        1. Declare both layouts in the same declaration
            - By using mutually exclusive selectors where each is applicable only in one case, yet the combination covers all cases
        2. Unify markup with filters (e.g. unwrap final destination URL of a link from a query parameter, replace some tags by others…)
        3. Skip the snapshot entirely (e.g. alternating between mobile and desktop pages). Choosing which ones to skip in the alternative is done with the following constraints:
            1. Maximise version quality (more markup, better readability)
            2. Maximise frequency (at least one version a day)
            3. Minimise changes to declaration
            4. Minimise declaration complexity
- Review versions and apply some sanity checks
    - Add filters

## Script usage instructions

### Prerequisites

- Clone this project.
- Install dependencies (`npm i`)
- Clone all three repositories of the instance associated with the document: `declarations`, `snapshots`, and `versions`.

### Edit the configuration

Add a new file in `config/development.js` with the following contents:

```json
{
  "services": {
    "declarationsPath": "../${YOUR_INSTANCE}-declarations/declarations"
  },
  "recorder": {
    "versions": {
      "storage": {
        "type": "git",
        "git": {
          "path": "../${YOUR_INSTANCE}-versions",
          "publish": false,
          "snapshotIdentiferTemplate": "https://github.com/OpenTermsArchive/france-snapshots/commit/%SNAPSHOT_ID",
          "author": {
            "name": "Open Terms Archive Bot",
            "email": "bot@opentermsarchive.org"
          }
        }
      }
    },
    "snapshots": {
      "storage": {
        "type": "git",
        "git": {
          "path": "../${YOUR_INSTANCE}-snapshots",
          "publish": false,
          "repository": "git@github.com:OpenTermsArchive/${YOUR_INSTANCE}-snapshots.git",
          "author": {
            "name": "Open Terms Archive Bot",
            "email": "bot@opentermsarchive.org"
          }
        }
      }
    }
  }
}
```

#### Run the script

History cleaning is much easier to do for one document type of one service at a time. So it is recommended to - choose which document (service ID and document type) you want to clean the history of and to iterate on services and document types once this one is done.

```sh
node ./scripts/cleanup/index.js --interactive --serviceId $SERVICE_ID_YOU_WANT_TO_WORK_ON --document "$DOCUMENT_TYPE_YOU_WANT_TO_WORK_ON"
```

For example:

```sh
npm run clean -- --interactive --serviceId Aigle --document "General Conditions of Sale"
```

To exit the script, type <key>ctrl-C</key>.

It's only when all declarations are fixed and all unwanted snapshots are marked as to be skipped that the whole history will be regenerated by no specifying service and document type and not enabling interactive mode.

```sh
npm run clean
```
