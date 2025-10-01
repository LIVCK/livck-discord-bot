# Release Process

This document describes the release process for LIVCK Discord Bot.

## 🚀 Creating a Release

### 1. Prepare the Release

1. **Update version in `package.json`:**
   ```bash
   npm version patch  # 1.0.0 -> 1.0.1
   npm version minor  # 1.0.0 -> 1.1.0
   npm version major  # 1.0.0 -> 2.0.0
   ```

2. **Update CHANGELOG.md** (if you have one):
   - Document new features
   - Document bug fixes
   - Document breaking changes

3. **Ensure all tests pass:**
   ```bash
   npm test
   ```

4. **Commit changes:**
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: bump version to v1.0.0"
   ```

### 2. Create and Push Tag

```bash
# Create annotated tag
git tag -a v1.0.0 -m "Release v1.0.0"

# Push tag to trigger release workflow
git push origin v1.0.0
```

**Important:** Always use semantic versioning (vMAJOR.MINOR.PATCH)

### 3. Automated Pipeline (GitHub Actions)

Once you push the tag, GitHub Actions automatically:

1. ✅ **Runs all tests** (`npm test`)
2. ✅ **Generates coverage report** (`npm run test:coverage`)
3. ✅ **Creates build artifact** (tar.gz with all necessary files)
4. ✅ **Generates changelog** (from commits since last tag)
5. ✅ **Creates DRAFT release** on GitHub

### 4. Review & Publish

1. Go to: https://github.com/YOUR_USERNAME/livck-discord-bot/releases
2. Find the **draft release** created by the workflow
3. **Review**:
   - Check changelog is correct
   - Verify artifact is attached
   - Test the artifact if needed
4. **Edit if necessary**:
   - Add additional release notes
   - Highlight breaking changes
   - Add screenshots/demos
5. **Publish the release** when ready

## 📋 Versioning Strategy

We follow [Semantic Versioning](https://semver.org/):

### MAJOR version (v2.0.0)
Breaking changes:
- Database schema changes requiring migration
- Command structure changes
- API breaking changes

### MINOR version (v1.1.0)
New features (backwards compatible):
- New commands
- New layouts
- New languages
- New features

### PATCH version (v1.0.1)
Bug fixes and improvements:
- Bug fixes
- Performance improvements
- Documentation updates
- Translation updates

## 🔍 Example Release Flow

```bash
# 1. Work on feature branch
git checkout -b feature/new-layout
# ... make changes ...
git commit -m "feat: add new layout option"
git push origin feature/new-layout

# 2. Create PR and merge to main
# ... PR is reviewed and merged ...

# 3. Update version on main branch
git checkout main
git pull origin main
npm version minor  # Creates commit + tag locally

# 4. Push to trigger release
git push origin main
git push origin v1.1.0  # Triggers GitHub Actions release workflow

# 5. Go to GitHub releases and review draft
# 6. Publish when ready!
```

## 🛠️ Release Checklist

Before creating a release:

- [ ] All tests passing locally (`npm test`)
- [ ] Version bumped in `package.json`
- [ ] CHANGELOG.md updated (if applicable)
- [ ] README.md is up to date
- [ ] No breaking changes without documentation
- [ ] Crowdin translations synced (`npm run i18n:download`)
- [ ] Git tag follows semantic versioning (vX.Y.Z)

## 🔒 Hotfix Releases

For critical bug fixes:

```bash
# 1. Create hotfix branch from main
git checkout -b hotfix/critical-bug main

# 2. Fix the bug
git commit -m "fix: critical bug in status updates"

# 3. Bump patch version
npm version patch

# 4. Merge to main and tag
git checkout main
git merge hotfix/critical-bug
git push origin main

# 5. Push tag to trigger release
git push origin v1.0.1
```

## 🎯 Release Artifacts

Each release includes:

- **Source code** (zip & tar.gz)
- **Build artifact** (tar.gz without node_modules, tests, .git)
- **README.md** (setup instructions)
- **LICENSE** (MIT License)
- **CROWDIN_SETUP.md** (translation guide)

## 📊 GitHub Actions Workflow

The release workflow consists of 3 stages:

1. **Test** - Runs all tests, generates coverage
2. **Build** - Creates distributable artifact
3. **Release** - Creates draft release with changelog

All stages must pass before a draft release is created.

## 🚨 Troubleshooting

### Release workflow fails

1. Check GitHub Actions logs: https://github.com/YOUR_USERNAME/livck-discord-bot/actions
2. Common issues:
   - Tests failing → Fix tests and re-tag
   - Permission issues → Check `GITHUB_TOKEN` permissions
   - Artifact size too large → Review included files

### Re-creating a release

```bash
# Delete tag locally and remotely
git tag -d v1.0.0
git push origin :refs/tags/v1.0.0

# Delete draft release on GitHub (manually)
# Fix issues, then re-create tag
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

## 🎉 Post-Release

After publishing a release:

1. Announce in Discord community (discord.livck.com)
2. Update documentation if needed
3. Monitor for issues
4. Respond to feedback

## 📚 Additional Resources

- [Semantic Versioning](https://semver.org/)
- [GitHub Releases Documentation](https://docs.github.com/en/repositories/releasing-projects-on-github)
- [Keep a Changelog](https://keepachangelog.com/)
