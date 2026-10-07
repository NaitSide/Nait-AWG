'use strict';
// Only human-readable diagnostics use this helper. Machine stdout stays unchanged.
function installerText(ru, en) {
  return process.env.NAIT_AWG_LANG === 'en' ? en : ru;
}
module.exports = {installerText};
