# Versions Cleaner

**This tool is currently using an unstable branch `[versions-cleaner](https://github.com/OpenTermsArchive/engine/tree/versions-cleaner)` of OpenTermsArchive/engine that exposes some needed core features**

Along the life of an instance, unsatisfactory versions of documents might be extracted from snapshots. For example, they might be changes unrelated to terms, or empty documents, or documents in a different language… Such unsatisfactory versions decrease the value of the dataset and it becomes impossible to measure the actual number of changes, for example.

Reviewing and cleaning the dataset entails **correcting the history** of declarations, **identifying** some **snapshots to skip**, and **extracting new versions** from the snapshots based on this information. In the end, the whole versions history will be rewritten and overwritten. The declarations will be completed. All the original snapshots are left unchanged and the previous state of the versions is still available, allowing auditability.

This script recreates a history of versions from existing snapshots and declarations, based on the current configuration.

It allows to review generated versions and correct services declarations if needed.
It also allows to skip unexploitable snapshots (empty content, botwall, loginwall, cookiewall, server error, …) or unwanted snapshots when there is a blink and we want to skip one in the alternative (switch between mobile and desktop pages, switch between languages, …).

This tool is currently a CLI command and a very nice addition would be to serve a web based interface of this.

## Process

The script follow this process:

- Iterate on every snapshot
- Extract version
  - This will automatically erase refilters. Indeed, refilters are only historical artifacts: they correct a version that should not have been recorded as it was in the first place.
- Ask user for a [decision to make](#cleaning-decisions)

## Install

### Prerequisites

- Clone this project.
- Install dependencies (`npm i`)
- Clone all three repositories of the collection you wish to clean: `declarations`, `snapshots`, and `versions`.

### Edit the configuration

Add a new file in `config/development.json` with the following contents adapted to the path above:

```json
{
  "services": {
    "declarationsPath": "../${YOUR_INSTANCE}-declarations/declarations",
    "repository": "https://github.com/OpenTermsArchive/${YOUR_INSTANCE}-declarations.git"
  },
  "recorder": {
    "versions": {
      "storage": {
        "type": "git",
        "git": {
          "path": "../${YOUR_INSTANCE}-versions",
          "publish": false,
          "snapshotIdentiferTemplate": "https://github.com/OpenTermsArchive/${YOUR_INSTANCE}-snapshots/commit/%SNAPSHOT_ID",
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

## Usage

```sh
npm run clean:versions -- --help
```

Actions taken using this CLI script will be reflected in a file named `cleaning/index.json` saved in the declarations folder (Field `services.declarationsPath` in the config)

This file will contain metadata on all the actions you took in order to clean the versions history.
It is aimed at being commited and pushed in a `versions-cleaner` branch. This way, several users can clean the terms at the same time and aggregate their results easily.

### Clean documents one by one

**NOTE**: History cleaning is much easier to manage going one term type of one service by one.

It is recommanded to use the `--list` option to see which documents have been already handled or not.

```sh
npm run clean:versions -- --list
```

You can also specify which service / terms types you wish to clean

```sh
npm run clean:versions -- --interactive --serviceId Aigle --documentType "General Conditions of Sale"
```

To exit the script, type <key>ctrl-C</key>.

### Cleaning decisions

For every snapshot that generates a different version, several choices will be proposed.

#### Keep the version
The version is fine and should be recorded as is.

**Note:** if the provider is in a certain manner unable to provide the document to its expected audience, and not only to Open Terms Archive, this should be tracked. Here are some examples of such a case:
- Undergoing maintenance
- Plain error written in HTML content

#### Decide later
It's not sure yet whether a version is fine or not. It will record the version as is but it is your responsibility to launch the cleaner again in case it was a mistake.

#### Retry
In case of a problem on the version generated, `history`, `declaration` file or `filters` may have to be adapted.

Potential reasons are:
- Some selector is wrong. Usually, that means the history date for applying that selector is wrong (otherwise the declaration was wrong from the beginning). Take the `fetchDate` of the last snapshot that does not fail to generate a version as `validUntil`
- Generated version markup differs significantly. See [recommended strategies](#cleaning-strategies)

When done, select retry to retry the extraction of the version from the snapshot.


#### Show data
To fine tune your judgment over if a version is valid or not, some information about it can be displayed.
- snapshot date
- snapshot data (serviceId, isFirstRecord, etc...)
- code of the HTML + a way to open the HTML page in a browser
- declaration that is currently being used to generate the version

#### Skip the snapshot

Sometimes a snapshot is unexploitable and should not generate a version.

A snapshot is unexploitable if it does not contain the tracked document. Here are some examples we have encountered so far:
  - Empty content
  - Botwall
  - Loginwall
  - Cookiewall
  - Server error

When this happens, several possibilities are available to skip it.

All these actions will create an entry in `cleaning/index.json` for the corresponding service and terms type.


##### Skip based on the content of a HTML element

Program will ask you then for the CSS selector to test and the content that, if found, will provoke the skip of this version.
**Note**: Content has to be strictly equal to the one described.

##### Skip based on the existence of a selector
Sometimes, a snapshot will be known as not processable if it contains a certain selector (`.error` for example).
Program will ask you then for the CSS selector which, if found, will make the version skipped.

##### Skip based on the non existence of a selector

Sometimes, a snapshot will be known as not processable if it does not contain a certain selector (`h1` for example).
Program will ask you then for the CSS selector which, if not found, will make the version skipped.

#### Update history

If content of the snapshots has changed and declaration should be changed. Updating history will automatically.
- Copy the current declaration in the `history` file
- Append the `validUntil` of the last snapshot

**Note** Declaration now has to be fixed with working selectors.
When done, the [Retry](#retry) decision can be used

### Finalize cleaning of one service and document type

When reaching the last snapshot, several choices will be available

- **Mark it as Done**: Cleaning went ok and all needed modifications have been done. This will add a new key `done: true` in the `cleaning/index.json` file and you will not be able to launch it again in interactive mode unless you remove the `done` key
- **Restart in non-interactive mode**: Launch the same command without `--interactive`. This will create the versions repository with the current configuration
- **Quit**: All modifications done are already included in the `cleaning/index.json` file but document will not be considered as `done`


### Clean all versions

It's only when all declarations are fixed and all unwanted snapshots are marked as to be skipped that the whole history will be regenerated by no specifying service and document type and not enabling interactive mode.

```sh
npm run clean
```

## Cleaning strategies

If version generated has significant changes, here are some strategies that can be used.

### Situations encountered
- Switching list styles (ordered to unordered list)
- Switching between mobile and desktop pages
- Switching between geographic region-optimised layouts
- Switching between languages (934bddb9cdf40e7c53b5c43d0db3dc393e2a2eb4)
- Switching between different browser-optimised layouts
- **Note**: these should happen less and less as:
    -  The Core is optimised to minimise such changes (single user agent)
    -  Deployment is optimised to minimise such changes (single well-known IP)
    -  Operations are optimised to minimise such changes (single process instead of parallel, decreasing the number of requests)

### Known tactics, by order of preference
1. Declare both layouts in the same declaration
    - By using mutually exclusive selectors where each is applicable only in one case, yet the combination covers all cases
2. Unify markup with filters (e.g. unwrap final destination URL of a link from a query parameter, replace some tags by others…)
3. Skip the snapshot entirely (e.g. alternating between mobile and desktop pages). Choosing which ones to skip in the alternative is done with the following constraints:
    1. Maximise version quality (more markup, better readability)
    2. Maximise frequency (at least one version a day)
    3. Minimise changes to declaration
    4. Minimise declaration complexity


## Pushing changes

Once all documents have been cleaned correctly, new versions are ready to be pushed on the repo.

Here is the procedure to follow in order to prevent conflicts

- Stop instance on the server `pm2 stop ota ota-release`
- Retrieve all snapshots on your local machine
- Retrieve all versions on your local machine
- Create a tag `git tag vX` on the versions repository and push it (in case something wrong happens)
- Launch the cleaner in non interactive mode `npm run clean` -> this will recreate the versions in the corresponding directory on your local machine
- Verify that versions are correctly recorded (README on first commit, no reextract commits, etc...)
- Force push on the version repository
- Reset origin hard in versions repository on the server
- Relaunch the server `pm2 start ota ota-release`


