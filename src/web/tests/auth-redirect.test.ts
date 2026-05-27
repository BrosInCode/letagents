import assert from 'node:assert/strict'
import test from 'node:test'

const { resolveSignInRedirect } = await import('../src/composables/useAuth')

test('resolveSignInRedirect prefers an explicit redirect', () => {
  assert.equal(
    resolveSignInRedirect('/in/github.com/owner/repo', {
      pathname: '/',
      search: '?redirect_to=%2Fin%2Fother%2Frepo',
      hash: '',
    }),
    '/in/github.com/owner/repo',
  )
})

test('resolveSignInRedirect uses repo-room redirect_to from the landing bounce', () => {
  assert.equal(
    resolveSignInRedirect(undefined, {
      pathname: '/',
      search: '?reason=repo_signin_required&room=github.com%2Fowner%2Frepo&redirect_to=%2Fin%2Fgithub.com%2Fowner%2Frepo%3Fview%3Dboard',
      hash: '#thread-1',
    }),
    '/in/github.com/owner/repo?view=board#thread-1',
  )
})

test('resolveSignInRedirect does not duplicate an existing redirect hash', () => {
  assert.equal(
    resolveSignInRedirect(undefined, {
      pathname: '/',
      search: '?reason=repo_signin_required&room=github.com%2Fowner%2Frepo&redirect_to=%2Fin%2Fgithub.com%2Fowner%2Frepo%23existing',
      hash: '#thread-1',
    }),
    '/in/github.com/owner/repo#existing',
  )
})

test('resolveSignInRedirect falls back to repo room when redirect_to is absent', () => {
  assert.equal(
    resolveSignInRedirect(undefined, {
      pathname: '/',
      search: '?reason=repo_signin_required&room=github.com%2Fowner%2Frepo',
      hash: '#thread-1',
    }),
    '/in/github.com/owner/repo#thread-1',
  )
})

test('resolveSignInRedirect ignores redirect_to outside repo sign-in bounce', () => {
  assert.equal(
    resolveSignInRedirect(undefined, {
      pathname: '/in/github.com/owner/repo',
      search: '?redirect_to=%2Fdocs',
      hash: '#thread-1',
    }),
    '/in/github.com/owner/repo?redirect_to=%2Fdocs#thread-1',
  )
})

test('resolveSignInRedirect keeps the current path, search, and hash otherwise', () => {
  assert.equal(
    resolveSignInRedirect(undefined, {
      pathname: '/docs',
      search: '?section=auth',
      hash: '#github',
    }),
    '/docs?section=auth#github',
  )
})
