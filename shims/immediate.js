// Replaces jszip's `immediate` dependency, whose IE8 fallback builds a <script>
// element and trips Obsidian's "creates script elements at runtime" check.
module.exports = function immediate(task) {
	const args = Array.prototype.slice.call(arguments, 1);
	queueMicrotask(function () {
		task.apply(undefined, args);
	});
};
