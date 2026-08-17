# G1 Public Publication Security Audit

Date: 2026-08-17

## Status

G1 is **not safe to publish from its historical branches** because an experimental Android release keystore and its password were committed in the old Git history.

A separate clean-history publication branch now exists:

- Branch: `public-clean-snapshot`
- Root commit: `a7806e9590b34345caf42f9a103c3db4f5b9b3c1`
- The root commit has no parents and therefore does not inherit the historical commits containing the signing material.

Do not make the existing historical repository public merely because the latest files were cleaned. Old commits and PR references can remain reachable.

## Confirmed sensitive material found in old history

1. `android/app/directchat.keystore` — experimental release signing key.
2. Release keystore password and key alias were hard-coded in `android/app/build.gradle`.
3. `android/app/debug.keystore` was also committed. It is not a production credential, but it was removed because it is unnecessary in the publication snapshot.

The application is not published to Google Play and is not distributed to users who require signature continuity, so the experimental release key is considered permanently retired.

## Remediation completed

Across the active development branches (`main`, `feat/zero-config-lan-discovery`, and `fix/unified-connection-runtime`):

- removed `android/app/directchat.keystore` from the current tree;
- removed `android/app/debug.keystore` from the current tree;
- removed hard-coded signing passwords and alias from Gradle;
- release signing now reads only protected environment variables:
  - `G1_RELEASE_STORE_FILE`
  - `G1_RELEASE_STORE_PASSWORD`
  - `G1_RELEASE_KEY_ALIAS`
  - `G1_RELEASE_KEY_PASSWORD`
- added ignore rules for `*.keystore`, `*.jks`, `*.p12`, `*.pfx`, `keystore.properties`, and `signing.properties`.

## Clean publication snapshot hardening

`public-clean-snapshot` additionally:

- starts from a root commit with no historical parents;
- does not contain the old release/debug keystore files;
- does not contain the old hard-coded signing password;
- removed the one-time `app-runtime-codemod.yml` workflow that had `contents: write` permission;
- removed its obsolete refactor trigger file;
- restricts the normal build workflow to `contents: read`;
- enables workflow concurrency cancellation;
- builds debug and unsigned release APKs without requiring signing secrets;
- accepts real release signing only through protected environment inputs.

## Secret-pattern scan of the clean root snapshot

No matches were found for the following high-risk patterns in the clean root snapshot during this audit:

- old signing password;
- `BEGIN PRIVATE KEY` / PEM private-key headers;
- GitHub classic token prefix `ghp_`;
- GitHub fine-grained token prefix `github_pat_`;
- AWS access-key prefix `AKIA`;
- Google API-key prefix `AIza`;
- Slack bot token prefix `xoxb-`;
- common `sk-` secret prefix;
- `client_secret`;
- npm `_authToken`.

This pattern scan is a guard, not a mathematical proof that no sensitive value can exist. Any future credentials must be supplied through GitHub Secrets/environments or another protected secret store, never committed.

## Publication rule

**Do not change the current historical `msabz/G1` repository to Public.**

Recommended publication path:

1. Create a new empty public repository under the same GitHub account.
2. Populate it only from `public-clean-snapshot`, preserving the clean root history and not importing/mirroring the old repository.
3. Run GitHub Actions in the new public repository.
4. Validate JS tests, Android unit tests, debug APK, and unsigned release APK.
5. Continue development there after CI is green.
6. Keep the old private repository as a private historical archive until no longer needed.

Do **not** use GitHub Import, mirror-push, normal fork, or a full clone with complete history for the public copy because those methods can carry the compromised historical objects.

## Release-signing policy going forward

Because no production signature continuity is required, generate a completely new release key only when a distributable release is needed.

The future private signing key must never be committed. Store it outside Git and inject it into CI only through protected secrets/files. Debug builds should use Android's normal debug signing.

## Current decision gate

The remaining manual step is creation of an empty public GitHub repository. Once that repository exists and is accessible to the GitHub connector, copy only the clean snapshot into it and immediately run CI.
