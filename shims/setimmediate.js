// Replaces jszip's `setimmediate` dependency, whose IE8 fallback builds a
// <script> element and trips Obsidian's "creates script elements at runtime" check.
// MessageChannel, not queueMicrotask: jszip uses this to yield between chunks,
// so it has to be a macrotask or long zip operations never release the thread.
if (typeof globalThis.setImmediate !== "function") {
	const tasks = new Map();
	const channel = new MessageChannel();
	let nextId = 1;
	channel.port1.onmessage = function (event) {
		const task = tasks.get(event.data);
		if (!task) return;
		tasks.delete(event.data);
		task();
	};
	globalThis.setImmediate = function (fn) {
		const args = Array.prototype.slice.call(arguments, 1);
		const id = nextId++;
		tasks.set(id, function () {
			fn.apply(undefined, args);
		});
		channel.port2.postMessage(id);
		return id;
	};
	globalThis.clearImmediate = function (id) {
		tasks.delete(id);
	};
}
