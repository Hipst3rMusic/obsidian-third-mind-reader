// jszip's browser shim for this forwards to Node's "stream", which doesn't exist
// on mobile. Nothing here uses jszip's node-stream path, so it reports absent:
// support.nodestream stays false and StreamHelper never loads the adapter.
module.exports = {};
