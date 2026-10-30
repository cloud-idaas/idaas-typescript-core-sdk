const path = require('node:path');
const { stage } = require('./release-tools.cjs');
stage(path.resolve(__dirname, '..'), process.argv[2] || process.env.IDAAS_SDK_ARTIFACT_DIR);
