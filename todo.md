# To-do

## Crucial Features
Potentially an API refactor. data-attributes are good, but the more features we add, the more cumbersome the library becomes. Maybe a better path would be to keep pre-baked motions into the data-anim attribute, while fine tuning would be in a wl-properties attribute. We should also look into renaming properties to make their function crystal clear

Expounded on in #nice-to-have-experimental, some way to positionally transform a target div, either by animating in from an edge of the screen, or between authored points.

Export the easing to CSS variables, letting developers use the physics engine without writing JS. Have an initialization method that takes a configuration, generates the curve, and injects it into the :root or a specific element as --wl-ease: linear and --wl-duration: 400ms.

## Important Features
Secondary motion, the ability to designate a child div as an inheritor of motion, and have it follow the parent div's curve on a delay. 

Secondary action, the ability to designate sibling divs as being effected by another's motion, for example, a falling column in a row of 3 would cause the others to bounce with a smaller curve. Could decay based on distance, derived from number of elements between specified items.

Sequential arcs, the ability to allow motion to naturally resolve. For example, a bouncing ball would not bounce a single time

Exit animations, via providing a .reverse(el) method that simply takes the cached transform sequence or easing string, swaps the start/end positions, and plays the timing array backward.

## Nice to have/ Experimental
Something resembling a timeline. Maybe by nesting divs with instructions, a dynamically created "Actor" div could be inserted into each child element after the parent's animation resolves, triggering its animation in order. (This idea needs refinement, nested divs sound clumsy)

Position marker divs. Allowing "actor divs" to interpolate between points. This solves a visual issue with squash and stretch, stretching in place looks awkward, positional transformation is necessary

Authored stagger patterns, add a few simple math modifiers to the stagger configuration. Examples:
Center-out: Calculate the middle index of the array, and base the delay on the absolute distance from the center.
Randomized: Multiply the stagger by Math.random() to make elements "pop" in chaotically.

Multi-property interpolation (color, border-radius, etc.), or applying the physical curve to non-transform properties. Right now, we feed the element translate3d or scale. We could just as easily feed it rgba(0,0,0,0) to rgba(255,100,50,1) or border-radius: 50% to border-radius: 0%. Animating a border-radius from 50% (a circle) to 0% (a square) using a spring curve makes the shape "wobble" into its final form. It adds an entirely new dimension of morphological animation without touching the core engine.

Squigglevision, this is more of a CSS-side addition, but implementing it into the feature set could be cute: https://css-tricks.com/books/greatest-css-tricks/squigglevision/