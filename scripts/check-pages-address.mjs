const repository = process.env.GITHUB_REPOSITORY;
if (repository !== 'soaringmatty/audio-looper') throw Error('Unexpected deployment repository');
const response = await fetch(`https://api.github.com/repos/${repository}/pages`, {
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
  },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok)
  throw Error(
    `Cannot read Pages configuration (HTTP ${response.status}); enable GitHub Actions in Pages settings first.`,
  );
const site = await response.json();
const expected = 'https://soaringmatty.github.io/audio-looper';
if (
  site.cname ||
  typeof site.html_url !== 'string' ||
  site.html_url.replace(/\/$/, '') !== expected
)
  throw Error('Deployment refused: only the default GitHub Pages address is allowed.');
// Do not log returned metadata: an accidental custom domain must not enter public logs.
console.log('Default GitHub Pages address verified.');
