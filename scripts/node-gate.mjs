/** Checks run on the CI Node major (22) or newer; older majors lack APIs the scripts use. */
const MIN_NODE_MAJOR = 22;

/** Accept any Node at or above the CI major. An exact match would reject valid newer releases. */
export function isSupportedNode(version) {
  const major = Number(String(version).split(".")[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}