/**
 * Default window for waiting on a runner's completion callback after the
 * job/pod has reached a terminal state. The runner posts its completion over
 * HTTP as its final step, so the record can lag the pod terminating (and a
 * server restart can race the callback). Shared so the live dispatch path
 * (KubernetesExecutionBackend.completionWaitMs) and the out-of-band reconciler
 * (RuntimeReconciler.completionGraceMs) use the same default grace window.
 */
export const DEFAULT_COMPLETION_WAIT_MS = 30_000;
