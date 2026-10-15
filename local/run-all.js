'use strict';
/**
 * Starts all three parts locally, each on its own origin (port), so the browser
 * applies real cross-origin rules between them:
 *   http://localhost:8081  simulated C4C host  <- open this
 *   http://localhost:8082  mock Nubitel        (framed by C4C)
 *   http://localhost:8083  BTP lean view       (framed by Nubitel)
 *
 * Note: different ports are different ORIGINS but the same SITE, so the
 * third-party cookie check always passes locally. Run that check on the real
 * domains (C4C tenant -> Nubitel domain -> BTP domain).
 */
const secret = process.env.TOKEN_SECRET || 'poc-only-change-me';
const base = { ...process.env, TOKEN_SECRET: secret };

require('../btp-view/server').start({ ...base, PORT: 8083, MESSAGE_ORIGINS: 'http://localhost:8082', FRAME_ANCESTORS: 'http://localhost:8082,http://localhost:8081' });
require('../mock-nubitel/server').start({ ...base, PORT: 8082, VIEW_URL: 'http://localhost:8083/', FRAME_ANCESTORS: 'http://localhost:8081', HOST_ORIGIN: 'http://localhost:8081' });
require('../mock-c4c-host/server').start({ ...base, PORT: 8081, NUBITEL_URL: 'http://localhost:8082/' });
