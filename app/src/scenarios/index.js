import fullStory from './full-story.js';
import attackerView from './attacker-view.js';
import challengeBinding from './challenge-binding.js';

/** All guided scenarios, by ID. A demo instance runs one of them on its own pair of browsers. */
export const scenarios = new Map([fullStory, attackerView, challengeBinding].map((scenario) => [scenario.id, scenario]));
