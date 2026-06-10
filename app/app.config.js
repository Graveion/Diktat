const base = require("./app.json");

// RC key is injected from the environment so it's never committed.
// For local dev/testing: create a .env.local file with RC_IOS_KEY=your_key
// For EAS builds: set RC_IOS_KEY as an EAS secret (eas secret:create)
base.expo.extra.revenueCatIosKey = process.env.RC_IOS_KEY ?? "";

module.exports = base;
