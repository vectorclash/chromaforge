// The words that go with a Reel: a caption written from the ad, one hashtag set, and a link.
//
// Instagram caps a post at FIVE hashtags (announced 18 Dec 2025, replacing 30), counted across the
// caption and the first comment together, so each set is exactly five and a post takes one set.
// Every set leads with #chromaforge: it gathers every post under one tag, and the other four
// pick the audience. Specific tags over giant ones (#art, #fashion), whose feeds a small
// account's post drops out of within seconds. No #printondemand: that tag's audience is other
// sellers, not buyers.
export const HASHTAG_SETS = [
  {
    id: 'art',
    label: 'Generative art',
    hint: 'The artwork itself, for people who follow code-made art',
    tags: ['chromaforge', 'generativeart', 'creativecoding', 'abstractart', 'digitalart']
  },
  {
    id: 'wear',
    label: 'Wearable art',
    hint: 'The product, for people looking for clothes that stand out',
    tags: ['chromaforge', 'wearableart', 'artapparel', 'streetwear', 'graphictee']
  },
  {
    id: 'motion',
    label: 'Motion',
    hint: 'The flight, for people who follow animation and 3D',
    tags: ['chromaforge', 'motiondesign', 'abstractanimation', '3danimation', 'generativeart']
  },
  {
    id: 'indie',
    label: 'Indie brand',
    hint: 'The maker, for people who like buying from small shops',
    tags: ['chromaforge', 'indiebrand', 'madetoorder', 'shopsmall', 'artistsoninstagram']
  }
];

export const DEFAULT_POST = { caption: null, tagSet: 'art' };

// A design's own page, for a Story link sticker or the bio link. Links in a Reel caption are not
// clickable, so this is not part of the caption. Built against the live site, not this page's
// origin -- the ad builder runs on localhost. A design with no saved row has no page of its own.
export function designLink(design) {
  return design?.id ? `https://chromaforge.app/studio?id=${design.id}` : 'https://chromaforge.app';
}

const listOf = names =>
  names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// Product names in the order the ad shows them, each once. The closing line is the bio's own
// ("Hit Generate. Get art. Wear it."), so a post and the profile it sits on say the same thing.
export function captionFor(design, productNames) {
  const unique = [...new Set(productNames.filter(Boolean))];
  const title = design?.title;
  const named = title && !/^(untitled|studio design|shared design)$/i.test(title);
  const subject = named ? title : 'A new design';
  const first = unique.length ? `${subject} on the ${listOf(unique)}.` : `${subject}.`;
  return [first, '', 'Hit Generate. Get art. Wear it.', '✦ chromaforge.app'].join('\n');
}

export const tagLine = set => set.tags.map(t => `#${t}`).join(' ');
