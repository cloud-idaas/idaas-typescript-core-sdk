# Publishing

Version-tag pushes to GitHub run `release.yml` automatically. The tag must be `v` followed by the package.json version. Pull requests and branch pushes run CI without publishing.

## Initial setup

- The GitHub repository must match package.json metadata. Repository mirroring must include version tags.
- The npm organization and package permissions must be ready, including any first-publication setup.
- Bind the package's npm Trusted Publisher to this GitHub repository and workflow filename `release.yml`, with direct `npm publish` allowed and no Environment name.
- Use GitHub-hosted runners. The workflow manages its required Node.js and npm tool versions.

After initial setup, each matching tag is verified and published without workflow inputs, publishing switches, or per-release approval. Declared dependency versions must be available in the registry. A failed check stops publication.

## Versions and channels

Update package versions, dependency versions, lockfiles, and user-facing release notes before creating a release tag. Published versions are immutable.

Prereleases use `beta` and stable releases use `latest`. Publishing an older version does not move these channels backwards. Each package is released independently.

For development commands, see [CONTRIBUTING.md](CONTRIBUTING.md). npm packages include runtime files, public declarations, usage examples, READMEs, release notes, and the license; contributor and publishing guides remain in the source repository.

Reference: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).
