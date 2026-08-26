// Kit partagé : envoie le PMTiles produit par l'étape "build-pmtiles" de
// n'importe quelle source vers le bucket S3 de destination (awscli).
// Référencé par `uses: upload` dans pipelines/<source>.yaml.
export default function () {
  return {
    image: 'debian:bookworm-slim',
    cmd: ['sh', '-c', 'bash /app/upload.sh'],
    allowNetwork: true, // upload.sh appelle l'API S3
    setup: {
      cmd: [
        'sh',
        '-c',
        'apt-get update && apt-get install -y --no-install-recommends awscli && rm -rf /var/lib/apt/lists/*',
      ],
      caches: [{ name: 'apt-cache', path: '/var/cache/apt', exclusive: true }],
      allowNetwork: true,
    },
    mounts: [{ host: '../scripts/common/upload.sh', container: '/app/upload.sh' }],
  }
}
