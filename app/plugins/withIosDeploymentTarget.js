// Expo config plugin: force every CocoaPods target to a minimum iOS deployment
// target. Xcode 27 rejects targets below 15.0, and several transitive pods
// (RevenueCat 13.0, GoogleUtilities 12.0, PromisesObjC 9.0, …) ship lower, so
// `expo prebuild` + build fails without this. expo-build-properties'
// `deploymentTarget` only sets the Podfile *platform*, not the per-pod targets,
// which is why this explicit post_install bump is needed.
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const MARKER = "IPHONEOS_DEPLOYMENT_TARGET'] = '"; // idempotency guard

module.exports = function withIosDeploymentTarget(config, { target = "15.1" } = {}) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let contents = fs.readFileSync(podfile, "utf8");
      if (contents.includes(MARKER)) return cfg; // already patched
      const snippet =
        "\n    installer.pods_project.targets.each do |t|\n" +
        "      t.build_configurations.each do |c|\n" +
        `        c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}'\n` +
        "      end\n" +
        "    end";
      contents = contents.replace(/(post_install do \|installer\|)/, `$1${snippet}`);
      fs.writeFileSync(podfile, contents);
      return cfg;
    },
  ]);
};
