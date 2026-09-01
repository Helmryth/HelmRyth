type ModalBoundaryElement = Pick<HTMLElement, "setAttribute" | "removeAttribute">;

export function syncModalBoundary(node: ModalBoundaryElement | null, active: boolean): void {
  if (!node) return;
  if (active) node.setAttribute("inert", "");
  else node.removeAttribute("inert");
}
