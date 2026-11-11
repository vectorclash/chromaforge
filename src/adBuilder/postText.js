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

// The 3D garments in the explainer are CC-BY 4.0, which asks for title, author, source and licence
// wherever the work is shared -- so an explainer's caption carries its garment's credit itself,
// and a post cannot go out without it. Words from each model's license.txt
// (public/models/tshirt, public/models/hoodie).
const GARMENT_CREDITS = {
  tee:
    '3D shirt: "Tshirt" by khalilchahi99 (sketchfab.com/3d-models/tshirt-a88d6e25d67c4b0c91b9ea013e679870), CC BY 4.0',
  hoodie:
    '3D hoodie: "Apricot printed hooded casual Hoodie" by Style3D CG (sketchfab.com/3d-models/apricot-printed-hooded-casual-hoodie-211f12b2949346e9ab24a20bf15528c8), CC BY 4.0'
};

// The bio's own words ("Hit Generate. Get art. Wear it."), so a post and the profile it sits on
// say the same thing. It comes FIRST: on a Reel only the first line shows over the video, and a
// stranger reached by an ad needs to be told what this is before anything else.
const TAGLINE = 'Hit Generate. Get art. Wear it.';

// `opts.explain` is the explainer's garment ('tee' | 'hoodie'); absent for every other format.
// Product names arrive in the order the ad shows them and are listed once each.
export function captionFor(design, productNames, opts = {}) {
  const lines = [TAGLINE, ''];
  if (opts.explain) {
    lines.push('Every tap makes a new piece. Keep the ones you love, then wear them.');
  } else {
    const unique = [...new Set(productNames.filter(Boolean))];
    const title = design?.title;
    const named = title && !/^(untitled|studio design|shared design)$/i.test(title);
    const subject = named ? title : 'A new design';
    // With no products and no real name there is nothing to say about this design in particular.
    if (unique.length) lines.push(`${subject} on the ${listOf(unique)}.`);
    else if (named) lines.push(`${subject}.`);
  }
  lines.push('chromaforge.app');
  const credit = opts.explain && GARMENT_CREDITS[opts.explain];
  if (credit) lines.push('', credit);
  return lines.join('\n');
}

export const tagLine = set => set.tags.map(t => `#${t}`).join(' ');

// Exactly what goes out: the caption (the ad's own until typed into) and the chosen hashtag set.
// Shared by Copy caption and Post, so the two can never send different words.
export function fullCaption(post, design, productNames, opts) {
  const set = HASHTAG_SETS.find(s => s.id === post.tagSet) ?? HASHTAG_SETS[0];
  return `${(post.caption ?? captionFor(design, productNames, opts)).trim()}\n\n${tagLine(set)}`;
}
