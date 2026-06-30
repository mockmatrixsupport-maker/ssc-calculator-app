#!/usr/bin/env python3
"""
patch_gradle_signing.py
Inserts a release signingConfig into android/app/build.gradle that reads
from -P (project property) flags passed on the gradlew command line.

A fresh `cap add android` project has no release signingConfig at all,
so assembleRelease/bundleRelease would silently produce UNSIGNED output
without this patch. Safe to run multiple times — it skips if already patched.
"""
import re
import sys

GRADLE_FILE = "android/app/build.gradle"

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

def main():
    with open(GRADLE_FILE, "r") as f:
        content = f.read()

    if "signingConfigs" in content:
        print(f"{GRADLE_FILE} already has signingConfigs — skipping patch")
        return

    # Insert signingConfigs block right after the opening "android {" line
    content, n1 = re.subn(r"(android\s*\{)", r"\1\n" + SIGNING_BLOCK, content, count=1)
    if n1 == 0:
        print("ERROR: could not find 'android {' block", file=sys.stderr)
        sys.exit(1)

    # Point the release buildType at the new signingConfig
    content, n2 = re.subn(
        r"(buildTypes\s*\{\s*release\s*\{)",
        r"\1\n            signingConfig signingConfigs.release",
        content,
        count=1
    )
    if n2 == 0:
        print("ERROR: could not find 'buildTypes { release {' block", file=sys.stderr)
        sys.exit(1)

    with open(GRADLE_FILE, "w") as f:
        f.write(content)

    print(f"Patched {GRADLE_FILE} with release signingConfig")

if __name__ == "__main__":
    main()
