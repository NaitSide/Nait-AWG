'use strict';
// Country exclusions produce about 22k CIDRs. Keep import/export bounds finite and identical.
module.exports = {MAX_CONFIG_BYTES:1024 * 1024, MAX_GUEST_BYTES:4 * 1024 * 1024, MAX_ENCODED_BYTES:1024 * 1024};
