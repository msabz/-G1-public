# Stable CI Debug signing continuity check

Date: 2026-08-19

PR #15 (`build: make CI debug APK updates installable`) merged to `main` at `512139d06acd83a163266eae58ad999864bbff73`.

Its final PR-head GitHub Actions run #197 (`32201027942`) passed JavaScript tests, React Native production bundling, Android unit tests, Debug APK assembly, explicit stable development-key signing, signing-certificate verification, Release APK assembly, and artifact uploads.

The Debug APK from run #197 is the first cutover artifact signed by the new dedicated CI development key. Devices carrying older ephemeral-CI-debug signatures require one final uninstall before installing it.

This documentation-only follow-up triggered GitHub Actions run #201 (`32201566467`) on the same protected signing key with a higher GitHub Actions run-number-derived `versionCode`; that run completed successfully and published `G1-DirectChat-debug-apk`.

Physical acceptance was then performed on 2026-08-19: run #197 had been installed after the one-time clean cutover, then the run #201 Debug APK was installed directly over #197 without uninstalling or clearing application data. The user tested the updated application and reported that everything was working normally. This confirms on-device CI Debug signing/versionCode update continuity for the tested device. Signing continuity is therefore DEVICE VERIFIED for this device, while cross-OEM continuity remains unverified until repeated on another target OEM if required.

P2P discovery remains separately NOT DEVICE VERIFIED and Phase 6b-b remains paused until the reported peer-invisibility regression is diagnosed.
