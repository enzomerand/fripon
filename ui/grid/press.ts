/**
 * A click on a Fripon control must stay between the control and us: the card's covering link would
 * open the item, and the page's own click handlers (analytics, "click outside" menus, the results
 * list that re-renders on a click) must not see a click they know nothing about. The handler of a
 * link that is meant to navigate keeps its default action and only calls `keepOffThePage`.
 */
export const press = (action: () => void) => (event: Event) => {
  event.preventDefault();
  event.stopPropagation();
  action();
};

export const keepOffThePage = (event: Event) => event.stopPropagation();
