#!/usr/bin/env python3
"""
patch_gradle_signing.py
1. Inserts a release signingConfig into android/app/build.gradle that reads
   from -P (project property) flags passed on the gradlew command line.
   A fresh `cap add android` project has no release signingConfig at all,
   so assembleRelease/bundleRelease would silently produce UNSIGNED output
   without this patch. Safe to run multiple times — it skips if already patched.

2. Bumps versionCode / versionName in android/app/build.gradle on every
   build (from VERSION_CODE / VERSION_NAME env vars). `npx cap add android`
   always regenerates a fresh Android project with versionCode=1,
   versionName="1.0" baked in — since that number never changed build to
   build, Android treated every new APK as the SAME version, so it looked
   like installing "the old version" again / silently refused to upgrade.

3. Bumps compileSdkVersion / targetSdkVersion in android/variables.gradle
   to a current API level. Google Play Protect blocks installs of apps
   that target an old Android API ("built for an older version of Android
   and doesn't include the latest privacy protections") — this fixes that.
"""
import os
import re
import sys

GRADLE_FILE = "android/app/build.gradle"
VARIABLES_FILE = "android/variables.gradle"

SIGNING_BLOCK = """
    signingConfigs {
        release {
            if (project.hasProperty('android.injected.signing.store.file')) {
                storeFile file(project.property('android.injected.signing.store.file'))
                storePassword project.property('android.injected.signing.store.password')
                keyAlias project.property('android.injected.signing.key.alias')
                keyPassword project.property('android.injected.signing.key.password')
            }
        }
    }
"""

# Current-generation API level. Google Play requires new/updated apps to
# target at least this level (raised roughly once a year) — keep this in
# sync with Play's latest requirement.
TARGET_SDK = "34"


def patch_signing(content):
    if "signingConfigs" in content:
        print(f"{GRADLE_FILE} already has signingConfigs — skipping signing patch")
        return content

    content, n1 = re.subn(r"(android\s*\{)", r"\1\n" + SIGNING_BLOCK, content, count=1)
    if n1 == 0:
        print("ERROR: could not find 'android {' block", file=sys.stderr)
        sys.exit(1)

    content, n2 = re.subn(
        r"(buildTypes\s*\{\s*release\s*\{)",
        r"\1\n            signingConfig signingConfigs.release",
        content,
        count=1
    )
    if n2 == 0:
        print("ERROR: could not find 'buildTypes { release {' block", file=sys.stderr)
        sys.exit(1)

    print("Patched build.gradle with release signingConfig")
    return content


def patch_version(content):
    version_code = os.environ.get("VERSION_CODE")
    version_name = os.environ.get("VERSION_NAME")

    if version_code:
        new_content, n = re.subn(r"versionCode\s+\d+", f"versionCode {version_code}", content, count=1)
        if n:
            content = new_content
            print(f"Set versionCode = {version_code}")
        else:
            print("WARNING: versionCode line not found in build.gradle", file=sys.stderr)

    if version_name:
        new_content, n = re.subn(r'versionName\s+"[^"]*"', f'versionName "{version_name}"', content, count=1)
        if n:
            content = new_content
            print(f"Set versionName = {version_name}")
        else:
            print("WARNING: versionName line not found in build.gradle", file=sys.stderr)

    return content


def patch_variables():
    if not os.path.exists(VARIABLES_FILE):
        print(f"WARNING: {VARIABLES_FILE} not found — skipping SDK bump", file=sys.stderr)
        return
    with open(VARIABLES_FILE, "r") as f:
        vcontent = f.read()

    vcontent, n1 = re.subn(r"compileSdkVersion\s*=\s*\d+", f"compileSdkVersion = {TARGET_SDK}", vcontent)
    vcontent, n2 = re.subn(r"targetSdkVersion\s*=\s*\d+", f"targetSdkVersion = {TARGET_SDK}", vcontent)

    with open(VARIABLES_FILE, "w") as f:
        f.write(vcontent)

    print(f"Bumped compileSdkVersion/targetSdkVersion to {TARGET_SDK} "
          f"({n1} + {n2} replacements) in {VARIABLES_FILE}")


def main():
    with open(GRADLE_FILE, "r") as f:
        content = f.read()

    content = patch_signing(content)
    content = patch_version(content)

    with open(GRADLE_FILE, "w") as f:
        f.write(content)

    patch_variables()


if __name__ == "__main__":
    main()
   
