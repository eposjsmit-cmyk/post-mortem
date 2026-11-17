// "What do these mean?" – plain-words explanations of the review terms.
import { VERDICT_INFO } from './analysis.js';
import { h, sheet } from './ui.js';

const VERDICT_TEXT = {
  best: 'The engine’s top choice, or just as good.',
  excellent: 'Almost perfect. Your chances barely changed.',
  good: 'A solid move. A little was left on the table.',
  inaccuracy: 'Not wrong, but there was something clearly better.',
  mistake: 'This made your position noticeably worse.',
  blunder: 'A big slip, often losing a piece or the game.',
  forced: 'The only legal move, so it doesn’t count either way.',
};

export function openReviewHelp() {
  sheet(
    'What do these mean?',
    h(
      'div.stack.help',
      h('h3', 'Winning chance'),
      h('p', 'How likely you are to win from a position, according to the engine. 50% is level. Each move is judged by how much it changed your winning chance.'),
      h('h3', 'Accuracy'),
      h('p', 'A score out of 100 for the whole game: how close your moves were to the engine’s best. Around 70–80 is normal for club players; 90+ is a really clean game.'),
      h('h3', 'Move labels'),
      h(
        'ul.help-verdicts',
        Object.entries(VERDICT_TEXT).map(([v, text]) => h('li', h(`span.verdict.v-${v}`, h('span.verdict-sym', VERDICT_INFO[v].symbol), VERDICT_INFO[v].label), h('span.muted', text))),
      ),
      h('h3', 'Arrows on the board'),
      h('p', h('strong.arrow-green', 'Green arrow'), ': what you should have played instead of a slip. ', h('strong.arrow-blue', 'Blue arrow'), ': the engine’s best move from the position on the board right now (switch it on below the board).'),
      h('h3', 'The bar next to the board'),
      h('p', 'The light part is White’s share, the dark part Black’s. The number is the engine’s score in pawns: +2 means White is about two pawns better.'),
    ),
  );
}
