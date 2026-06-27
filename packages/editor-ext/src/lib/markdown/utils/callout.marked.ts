import { Token, marked } from 'marked';
import { normalizeCalloutType, renderCalloutHtml } from './callout-common.marked';

interface CalloutToken {
  type: 'callout';
  calloutType: string;
  text: string;
  raw: string;
}

export const calloutExtension = {
  name: 'callout',
  level: 'block',
  start(src: string) {
    return src.match(/:::/)?.index ?? -1;
  },
  tokenizer(src: string): CalloutToken | undefined {
    const rule = /^:::([a-zA-Z0-9]+)\s+([\s\S]+?):::/;
    const match = rule.exec(src);

    if (match) {
      return {
        type: 'callout',
        calloutType: normalizeCalloutType(match[1]),
        raw: match[0],
        text: match[2].trim(),
      };
    }
  },
  renderer(token: Token) {
    const calloutToken = token as CalloutToken;
    return renderCalloutHtml(
      calloutToken.calloutType,
      marked.parse(calloutToken.text),
    );
  },
};
