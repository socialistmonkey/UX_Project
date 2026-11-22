// Apple Silicon Macs refuse to open an app with a broken or missing signature
// ("Image Bender is damaged"). Without a paid Developer ID we sign ad hoc,
// which is free and makes the app open after right-click -> Open.
//
// Universal build: electron-builder first packs an x64 and an arm64 copy into
// "*-temp" folders and merges them. If each copy is signed on its own, the two
// signature files differ and the merge fails. So the temp copies are left
// unsigned and only the merged universal app is signed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');

  if (context.appOutDir.endsWith('-temp')) {
    fs.rmSync(path.join(app, 'Contents', '_CodeSignature'), { recursive: true, force: true });
    console.log('  • universal build: skipped signing the temporary copy ' + context.appOutDir);
    return;
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('  • ad-hoc signed ' + app);
};
