#!/bin/sh
# Construit l'APK Android sans Gradle ni Android Studio :
# aapt2 (ressources) + javac (code) + dx (format Android) + zipalign + apksigner.
# Prérequis (Ubuntu) : apt install android-sdk-build-tools android-sdk-platform-23 apksigner zipalign
# Usage : KEYSTORE=chemin.jks KS_PASS=motdepasse ./build-apk.sh   (depuis le dossier android/)
set -e
ICI=$(cd "$(dirname "$0")" && pwd)
SDK=${ANDROID_SDK:-/usr/lib/android-sdk}
OUTILS=${OUTILS:-$SDK/build-tools/29.0.3}
PLATEFORME=${PLATEFORME:-$SDK/platforms/android-23/android.jar}
VERSION_CODE=${VERSION_CODE:-8}
VERSION_NOM=${VERSION_NOM:-0.8.0}
TRAVAIL=$ICI/build
rm -rf "$TRAVAIL" && mkdir -p "$TRAVAIL/compile" "$TRAVAIL/classes" "$TRAVAIL/assets/www"

# 1. Application web compilée pour l'APK (vite build --mode apk → dist-apk)
cp -r "$ICI/../dist-apk/." "$TRAVAIL/assets/www/"

# 2. Ressources et manifeste
"$OUTILS/aapt2" compile --dir "$ICI/res" -o "$TRAVAIL/compile/res.zip"
"$OUTILS/aapt2" link -o "$TRAVAIL/base.apk" -I "$PLATEFORME" --manifest "$ICI/AndroidManifest.xml" \
  --min-sdk-version 23 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NOM" \
  -A "$TRAVAIL/assets" "$TRAVAIL/compile/res.zip"

# 3. Code Java → bytecode Android
javac -encoding UTF-8 -source 8 -target 8 -nowarn -Xlint:-options -bootclasspath "$PLATEFORME" \
  -d "$TRAVAIL/classes" $(find "$ICI/src" -name '*.java')
if [ -x "$OUTILS/dx" ]; then
  "$OUTILS/dx" --dex --min-sdk-version=23 --output="$TRAVAIL/classes.dex" "$TRAVAIL/classes"
else
  # build-tools récents : d8 remplace dx
  "$OUTILS/d8" --min-api 23 --lib "$PLATEFORME" --output "$TRAVAIL" $(find "$TRAVAIL/classes" -name '*.class')
fi
(cd "$TRAVAIL" && zip -q base.apk classes.dex)

# 4. Alignement et signature (v1 + v2 + v3)
"$OUTILS/zipalign" -f -p 4 "$TRAVAIL/base.apk" "$TRAVAIL/aligne.apk"
"$OUTILS/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --ks-key-alias "${KS_ALIAS:-decodeur}" \
  --min-sdk-version 23 --out "$ICI/DF-Gestion-$VERSION_NOM.apk" "$TRAVAIL/aligne.apk"
"$OUTILS/apksigner" verify --print-certs "$ICI/DF-Gestion-$VERSION_NOM.apk" | head -3
echo "APK : $ICI/DF-Gestion-$VERSION_NOM.apk"
