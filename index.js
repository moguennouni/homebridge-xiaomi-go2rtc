'use strict';

const { XiaomiGo2rtcPlatform, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, XiaomiGo2rtcPlatform);
};
