const builtins = [
  {
    id: 'studio-knotless',
    title: 'That final turn',
    label: 'Knotless braids',
    description:
      'A client smiles and swings her finished knotless braids in front of the Mado Braids sign',
    locations: ['Home hero', 'Our Work'],
    showInWork: true,
  },
  {
    id: 'transformation',
    title: 'Before & after',
    label: 'Spring twists',
    description:
      'Spring twists from the first parted section to the finished look',
    locations: ['Our Work'],
    showInWork: true,
  },
  {
    id: 'at-the-chair',
    title: 'Made by hand',
    label: 'At the chair',
    description: 'Braiding a client in a purple cape',
    locations: ['Home', 'Our Work'],
    showInWork: true,
  },
  {
    id: 'braid-detail',
    title: 'Up close',
    label: 'Boho curls',
    description: 'A close look at braided sections and curly lengths',
    locations: ['Our Work'],
    showInWork: true,
  },
  {
    id: 'studio-tour',
    title: 'Inside the studio',
    label: 'The Lanham studio',
    description:
      'Inside the Lanham studio, with arched mirrors and styling chairs',
    locations: ['Home', 'About'],
    showInWork: false,
  },
].map((v) => ({
  ...v,
  src: `/media/${v.id}.mp4`,
  poster: `/media/${v.id}.webp`,
  enabled: true,
  builtin: true,
}));

export function studioVideos(settings = {}) {
  const saved = settings.videos?.items || [];
  return [
    ...builtins.map((v) => ({
      ...v,
      ...saved.find((item) => item.id === v.id),
    })),
    ...saved.filter((v) => !builtins.some((item) => item.id === v.id)),
  ].map((v) => ({
    ...v,
    locations: [
      ...(v.locations || []).filter((place) => place !== 'Our Work'),
      ...(v.showInWork ? ['Our Work'] : []),
    ],
  }));
}
