# Stable CI Debug signing continuity check

Date: 2026-08-19

PR #15 (`build: make CI debug APK updates installable`) merged to `main` at `512139d06acd83a163266eae58ad999864bbff73`.

Its final PR-head GitHub Actions run #197 (`32201027942`) passed JavaScript tests, React Native production bundling, Android unit tests, Debug APK assembly, explicit stable development-key signing, signing-certificate verification, Release APK assembly, and artifact uploads.

The Debug APK from run #197 is the first cutover artifact signed by the new dedicated CI development key. Devices carrying older ephemeral-CI-debug signatures require one final uninstall before installing it.

This documentation-only follow-up intentionally triggers a later CI build with the same protected signing key and a higher GitHub Actions run-number-derived `versionCode`. Physical acceptance is: install run #197 cleanly, then install this later Debug APK over it without uninstalling and confirm application data survives. Until that succeeds, signing continuity is CI-verified but not device-verified.

P2P discovery remains separately NOT DEVICE VERIFIED and Phase 6b-b remains paused until the reported peer-invisibility regression is diagnosed.