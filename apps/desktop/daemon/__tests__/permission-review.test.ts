import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { agentBranchSegment, isAgentBranch, leasedBranchRef } from "../../../../shared/agent-branch.mjs";
import {
  PERMISSION_REVIEW_MAX_COMMANDS,
  PERMISSION_REVIEW_MAX_COMMAND_CHARS,
  buildPermissionReviewRequest,
  commandNeedsPerson,
  commandOnlyReads,
  decidePermissionReview,
  parsePermissionReviewAnswers,
  partsAreInCommand,
  routineCommandReview,
} from "../../../../shared/permission-review.mjs";

const project = "/Users/dev/shop-api";
const evaluation = JSON.parse(readFileSync(new URL("../../../../scripts/permission-review-eval.cases.json", import.meta.url), "utf8")) as {
  project: string;
  cases: Array<{ command: string; expect: "allow" | "ask" | "probe"; rule?: boolean }>;
  rules_only: string[];
};
const needsPerson = (commands: readonly string[], why: string) => {
  for (const command of commands) assert.equal(commandNeedsPerson(command, project), true, `${why}: ${JSON.stringify(command)}`);
};
const readable = (commands: readonly string[]) => {
  for (const command of commands) assert.equal(commandNeedsPerson(command, project), false, JSON.stringify(command));
};

test("the rules read plain reading and checking commands", () => {
  readable([
    "ls", "ls -la src", "pwd", "cat package.json", "cat src/a.ts src/b.ts", "head -40 README.md", "tail -50 logs/test.log", "wc -l src/index.ts",
    "grep -rn parseDate src", "grep -rn 'parse Date' src", "grep -rn \"parse Date\" src", "rg TODO", "rg -n 'a.*b' src",
    "find src -name '*.test.ts'", "find . -type f -newer package.json", "find src -type f -not -name '*.ts' -print", "sort names.txt", "sort -rn names.txt",
    "sort names.txt | uniq -c", "diff -u src/a.ts src/b.ts", "ls -la src | head -20", "cat src/a.ts | grep -n foo", "grep -rn -A 3 foo src", "grep -c foo src/a.ts",
    "head -n 5 a.txt", "head -5 a.txt", "tail -n 20 a.txt", "wc -lw a.txt", "cut -d , -f 1 a.csv", "git grep -n formatPrice", "git grep -n -e formatPrice -- src",
    "git log -5", "git log -n 5 --oneline", "git diff --stat HEAD~2 -- src/a.ts src/b.ts", "git rev-parse --abbrev-ref HEAD", "git ls-files --others --exclude-standard",
    "tree -L 2 src", "du -sh dist", "stat README.md", "echo done", "which node", "date", "date +%s",
    "git status", "git diff", "git diff --stat", "git diff HEAD~1 -- src/a.ts", "git log --oneline -5", "git log --format=%h", "git show HEAD:src/a.ts",
    "git show HEAD --stat", "git blame src/a.ts", "git ls-files src", "git branch --show-current", "git tag --list",
    "npm test", "npm test -- src/utils/date.test.ts", "npm run build", "npm run typecheck", "npm run test:unit", "npm ls --depth=0", "pnpm test", "yarn test", "bun test", "npm test src/a.test.ts", "npm test -- src/a.test.ts",
    "npx --no-install tsc --noEmit", "npx --no vitest run src/a.test.ts", "tsc --noEmit", "tsc --noEmit -p tsconfig.json", "vitest run", "vitest --run src/a.test.ts",
    "jest src/utils", "jest a.test.ts", "prettier --check src/", "prettier -c .", "eslint src/", "eslint .", "mocha test/a.spec.js", "biome check src/",
    "go test -run=TestX -count=1 ./...", "cargo test --workspace", "cargo fmt --check", "npm test | tail -20", "ls | head -5", "cat a.txt | grep -n x",
    "node --version", "node scripts/gen.js", "node --test", "node --import tsx --test src/a.test.ts", "node --import=tsx --test --test-concurrency=1 src/a.test.ts",
    "python manage.py", "python3 -m pytest -q tests/", "pytest -q tests/test_dates.py", "go test ./...", "go vet ./...", "cargo test", "cargo check", "make test", "make build lint",
    "npm run typecheck && npm test", "npm test; git status", "git status\ngit diff", "npm test || echo failed", "npm test 2>&1", "npm test 2>&1 | tail -40",
    "npm test > /dev/null", "npm test >/dev/null 2>&1", "npm test 2> /dev/null", "ls;", "\nls\n\n",
    "cat /Users/dev/shop-api/src/a.ts", "ls /Users/dev/shop-api", "ls /Users/dev/shop-api/", "cat ./src/a.ts", "cat src/a..b.ts", "grep -rn x --include=src/a.ts",
  ]);
  assert.equal(commandNeedsPerson("ls /Users/dev/shop-api/src", "/Users/dev/shop-api/"), false);
});

test("the evaluation's listed commands never reach a model, and its routine commands are marked when a rule stops them", () => {
  assert.equal(evaluation.rules_only.length >= 70, true);
  for (const command of evaluation.rules_only) {
    assert.equal(commandNeedsPerson(command, evaluation.project), true, command);
    assert.equal(buildPermissionReviewRequest({ commands: ["ls", command], project: evaluation.project, task: "anything" }), null, command);
  }
  for (const item of evaluation.cases) {
    assert.equal(commandNeedsPerson(item.command, evaluation.project), item.rule === true, item.command);
  }
});

test("a program that is not listed, or not named plainly, needs a person", () => {
  needsPerson([
    "rm x", "rm -rf x", "rm -- x", "rmdir x", "unlink x", "mv a b", "cp a b", "mkdir x", "touch x", "ln -s a b", "tee x", "chmod 777 a", "install -m 4755 a b",
    "sudo ls", "bash -c ls", "sh x.sh", "zsh -c ls", "eval ls", "source x", "xargs rm", "curl https://example.com", "wget x", "ssh host", "scp a b", "nc a 1",
    "openssl s_client", "kill 1", "pkill node", "printenv", "env", "set", "export X=1", "history", "trap x EXIT", "sed -i s/a/b/ f", "sed -n p f", "awk 1 f",
    "perl -e 1", "ruby -e 1", "php -r 1", "deno eval 1", "tsx -e 1", "docker run x", "kubectl get pods", "terraform plan", "gh pr list", "psql -c x", "jq . package.json",
    "tar czf x.tgz src", "zip -r x src", "gzip f", "open x", "osascript -e x", "brew install x", "pip install x", "java -jar x.jar", "gradle run", "./evil", "src/evil",
    "/bin/ls", "/Users/dev/shop-api/node_modules/.bin/tsc", "node_modules/.bin/tsc",
  ], "unlisted program");
  needsPerson([
    "LS", "Ls -la", "RM -rf x", "GIT status", "Git status", "NPM test", "'ls'", "\"ls\"", "'ls' -la", "l's'", "\\ls", "=ls", "cat =ls",
    "X=1 ls", "PATH=. ls", "NODE_OPTIONS=--require=./x.js npm test", "GIT_EXTERNAL_DIFF=./evil git diff", "LD_PRELOAD=./x.so ls",
    "env ls", "env -u X ls", "command ls", "exec ls", "nohup ls", "time ls", "nice ls", "timeout 5 ls", "noglob ls", "busybox ls", "arch -arm64 ls",
  ], "disguised or wrapped program");
});

test("anything a shell would expand, escape, group, or redirect needs a person", () => {
  needsPerson([
    "echo $(ls)", "echo `ls`", "cat <(ls)", "ls $X", "ls ${X}", "ls $1", "ls $@", "ls $'x'", "ls $\"x\"", "cat $'\\x2e\\x2e/x'",
    "ls \\-la", "ls a\\ b", "cat ..\\/x", "ls \\\nsrc", "ls {a,b}", "cat .{env,x}", "ls *", "ls *.ts", "cat .e*", "cat .en?", "cat .e[n]v", "ls !x",
    "ls # reads files", "ls;# reads files", "ls #", "(ls)", "{ ls; }", "ls &", "ls & ls", "ls |& cat", "ls ;; ls", "; ls", "&& ls", "| ls", "ls &&", "ls ||", "ls |",
    "ls && && ls", "ls | | cat", "ls;;",
    "echo x > out.txt", "echo x >out.txt", "echo x >> out.txt", "> package.json", "echo x >| out.txt", "echo x >& out.txt", "echo x >! out.txt", "ls 2> err.txt",
    "ls > /dev/nullx", "ls > /dev/null/x", "ls > /dev/stdout", "ls >/etc/hosts", "cat < in.txt", "cat <in.txt", "cat <<EOF", "cat <<<x", "ls>/dev/null", "ls 2>&1x",
    "ls 3>&1", "ls 2>&3", "exec >out",
    "ls 'a'b", "ls a'b'", "ls 'a''b'", "ls \"a\"'b'", "ls 'unterminated", "ls \"unterminated", "ls \"$HOME\"", "ls \"`ls`\"", "ls \"a\\b\"", "ls \"!x\"", "ls 'a\nb'",
    "rm '-rf' x", "find src '-delete'", "find src -de''lete",
    "ls\u00a0-la", "cat /Users/dev/shop-api\u00a0x", "ls\r", "ls\rrm -rf x", "ls\u2028ls", "ls\u0000", "ls\u001b[2K", "ls \u202e", "ls\u007f", "ls\u000bls", "ls\u000cls", "café",
  ], "unreadable shape");
});

test("a command that names anything outside the project needs a person", () => {
  needsPerson([
    "cat /etc/passwd", "ls /", "ls /Users/dev", "ls /Users/dev/shop-api-other", "cat /Users/dev/shop-api/../other/x", "cat //etc/passwd", "cat /./etc/passwd",
    "cat /Users/dev/shop-api//src", "cat /Users/dev/shop-api/./src", "ls ..", "ls ../", "cat ../x", "cat src/../../x", "cat ./../x", "ls ..;ls", "ls .. | cat", "ls ..\nls",
    "ls ~", "ls ~/x", "cat ~root/x", "ls ~+", "ls ~-", "cat a:~/x", "ls --color=~/x", "cat '~/x'", "cat '../x'", "cat '/etc/passwd'", "cat \"/etc/passwd\"",
    "sort -o/abs/x f.txt", "grep -f/etc/passwd f.txt", "sort -o../x f.txt", "ls -I/etc", "cat --file=/etc/passwd", "grep -rn x --include=../x", "cat a:/etc/passwd",
    "cat a,/etc/passwd", "cat x=/etc/passwd", "cat https://example.com/x", "cat file:///etc/passwd", "git show HEAD:../x",
  ], "outside the project");
  for (const root of ["", "shop-api", "./shop-api", "/", "/Users/dev/../x", "/Users/dev/./x", "/Users//dev", "/Users/dev/shop api", "/Users/dev/shop-api\u0000", "/Users/dév", 7, null, undefined, {}]) {
    assert.equal(commandNeedsPerson("ls", root), true, String(root));
  }
});

test("credentials and the repository's own history store need a person", () => {
  needsPerson([
    "cat .env", "cat .env.local", "cat config/.env", "cat src/.ENV", "cat .envrc", "cat .env_production", "ls .ssh", "cat .aws/credentials", "cat .npmrc", "cat .netrc", "cat .pgpass",
    "cat secrets.json", "cat config/credentials.yml", "cat API_KEY.txt", "cat api-key.txt", "cat private_key.pem", "cat cert.pem", "cat server.key", "cat ssl/tls.crt",
    "cat terraform.tfstate", "cat id_rsa", "cat id_ed25519.pub", "grep password config.yml", "cat token.json", "cat '.env'", "cat \".env\"", "grep -rn x --include=.env",
    "cat .git/config", "ls .git", "cat .GIT/config", "cat .Git/HEAD", "cat src/.git/config", "cat '.git/config'", "git show HEAD:.git/config",
  ], "credential or history");
  readable(["cat .gitignore", "cat .github/workflows/ci.yml", "cat src/environment.ts", "cat .eslintrc.json", "cat src/keyboard.ts"]);
});

test("a listed program is held to the arguments that only read or check", () => {
  needsPerson([
    // A flag that the tool reads as taking the next word, and a bare word it reads as a subcommand.
    "tsc --noEmit false a.ts", "tsc --noEmit false", "tsc -p tsconfig.json --noEmit false", "tsc '--noEmit' false a.ts", "tsc --noEmit null a.ts", "tsc --noEmit a.ts",
    "vue-tsc --noEmit false", "vitest", "vitest watch", "vitest dev", "vitest init browser", "vitest --run false", "vitest --run watch", "vitest related a.ts",
    "mocha init x", "ava debug x.js", "jest utils", "eslint src", "prettier --check src", "pytest tests", "npm test utils", "biome src/", "biome format src/",
    // Code that arrives through a pipe runs in whatever the receiving script starts.
    "echo x | npm run repl", "echo x | make repl", "echo x | npm test", "echo x | pnpm test", "echo x | pytest", "echo x | go test ./...", "echo x | cargo test",
    "echo x | npx --no-install jest a.test.ts", "echo x | jest a.test.ts", "echo x | tsc --noEmit", "echo x | python3 a.py", "echo x |\nnode a.js", "echo x |\nnpm test",
    "cat a.js | python3 -m pytest",
    // How an option is read.
    "cat -20 a.txt", "ls -5", "head -n -5 a.txt", "head -n '' a.txt", "grep -A -B f", "git log --oneline=x", "ls -la=x", "grep -rA 3 x src", "head -n=20 f", "cut -f=1 f",
    "sort -k=2 f", "du -d=1", "git diff -U=5", "git log --onelin", "git log --stat-width", "git log -oneline", "git log -stat", "go test --run=x ./...", "cargo test -workspace",
    "git log --format=%GG", "git log --pretty=%G?", "git log --format %GK",
    // A program runs what arrives on its input when the word after an option is taken as that option's value.
    "node -e x.js", "node -p x.js", "node --eval=1 x.js", "node --print x.js", "node --version x.js", "node -v -e 1", "node -x.js", "node a.js --flag", "node a.js -e 1",
    "node a.js /etc/passwd", "node a.js ../x", "python -x.py", "python a.py --flag", "python a.py /etc/passwd", "python3 -m pytest --pastebin=all", "python3 -m pytest -p x",
    "python -m unittest", "python -m pytest tests",
    "echo x | node --test-name-pattern x.js", "node --test-name-pattern x.js", "node --test-timeout 1.js", "node --test-reporter x.js", "node --experimental-loader ./x.js",
    "echo x | python3 -ic.py", "python3 -ic.py", "python -i a.py", "echo x | node", "echo x | node a.js", "echo x | python a.py", "ls | node --test", "cat a.js | node --test b.js",
    // Options a program accepts shortened, bundled, or under another spelling.
    "git grep --open=rm one", "git grep --open-files-in-page=rm one", "git grep -nOrm one", "git grep -lOrm one", "git grep '--open=rm' one", "git grep -e one --open=rm",
    "sort --out=package.json f.txt", "sort --o=package.json f.txt", "sort --outpu package.json f.txt", "sort --files0=list.txt",
    "node --test --test-reporter=tap --test-reporter-destination=package.json", "node --test --test-update-snapshots", "node --watch a.js", "node --env-file=x a.js",
    "tsc", "tsc a.ts", "tsc --outdir out a.ts", "tsc --INIT", "tsc -init", "tsc --generatetrace tr a.ts", "tsc --OUTFILE package.json --module amd a.ts", "tsc --noEmit --outFile x",
    "tsc --noEmit -w", "tsc --noEmit --init", "tsc --noEmit --tsBuildInfoFile x", "uniq f.txt -c", "ls src -la", "cat a.txt -n",
    "go test --exec 'rm -rf victim'", "go build", "go build --o=package.json", "go vet --vettool=./evil", "go list -m -u all", "go test -exec x", "go test -toolexec x", "go test -o x",
    "go test -overlay x", "go test -modfile x", "go test -C x",
    "pytest --pastebin=all", "pytest --junitxml=package.json", "pytest --log-file=package.json", "pytest @/tmp/args.txt", "pytest @args.txt", "pytest --pyargs x", "pytest --confcutdir x",
    "pytest --basetemp x", "pytest -o x=y", "pytest --override-ini x=y", "tsc --noEmit @args.txt", "cat @x", "cat --x=@/etc/hosts",
    "eslint -o package.json src", "eslint --output-file=package.json", "eslint -f ./evil.js", "eslint --mcp", "eslint --fix src", "eslint -c x src", "eslint --rulesdir x src",
    "jest --output-file=package.json --json", "jest --outputFile=x", "jest --global-setup=./evil.js", "jest --globalSetup x", "jest --setup-files ./x", "jest --runner=./evil.js",
    "jest --config x", "jest --coverage", "mocha -R xunit -O output=package.json", "mocha --file ./evil.js", "mocha -n require=./evil", "mocha --require x", "mocha -r x",
    "vitest --output-file=package.json", "vitest --api", "vitest --ui", "vitest --config x", "vitest --reporter x", "ava --config x", "prettier README.md", "prettier --write README.md",
    "prettier --check --plugin x src", "biome format src", "biome check --write src", "biome ci", "vue-tsc", "vue-tsc --build", "cargo fmt", "cargo fmt --all",
    "yarn run shx -- rm -rf victim", "yarn run build", "bun run build", "pnpm run build", "bun x cowsay", "npm run build -- --x", "npm run shx -- rm -rf x", "npm test -- --watch",
    "npm test --watch", "npm test extra --flag", "npm restart", "npm stop", "npm ls x", "npm run clean", "npm run install-hooks",
    "date -s 2020", "date --set 2020", "date -f x", "find . -execdir ls ;", "find . -okdir ls ;", "find . -fprint0 x", "find . -fprintf x y", "find . -files0-from x", "find . -name",
    "rg --hostname-bin x y", "rg --ignore-file x y", "rg --type-add x y", "rg --pre x y", "rg --files-from x", "sort --compress-program x f", "sort -T x f", "sort --temporary-directory x f",
    "git log --exec=x", "git diff --upload-pack=x", "git diff --receive-pack=x", "git for-each-ref", "git difftool", "git archive x", "git ls-remote", "git cat-file -p HEAD", "git branch -m a b",
    "cargo test --manifest-path x", "cargo check --target-dir x", "cargo test -Z x", "cargo clippy --fix", "cargo test -C x", "cargo build", "cargo test --config x",
    "head -c", "grep -e", "git log -n", "git log -n x", "head -n x a.txt", "cat -", "cat -- -x", "grep -- -x f", "grep -f x f", "ls --color=always", "ls -Z", "cat -v a", "wc --files0-from=x",
    "curl x", "less x", "file x", "id", "ps", "true", "tr a b", "nl a", "cmp a b", "comm a b", "jq . a.json", "egrep x f", "xargs ls",
    "prettier --check --write src/", "prettier --write --check src/", "biome check --apply src/", "biome lint --fix src/", "vue-tsc --noEmit -b", "vue-tsc --noEmit --watch",
    "mocha --watch test/a.js", "mocha --inspect test/a.js", "ava --watch", "ava -u", "jest -u", "jest --watch", "pytest --tb=x", "pytest --tb x", "go version x", "go version -m x",
    "go test -c ./...", "go test -json ./...", "go test -cover ./...", "go vet -n ./...", "go test -x ./...", "go test 'a b'", "cargo test -p ../x", "cargo test -p -x",
    "cargo test 'a b'", "cargo check deploy", "npx --yes tsc --noEmit", "npx -y tsc --noEmit", "npx tsc --noEmit", "npm ls -g", "npm ls --prefix=x", "npm list --global",
    "git branch -d x", "git branch -D x", "git branch --delete x", "git tag -d v1", "git tag -a v1", "git diff -- ../x", "git diff -- /etc/passwd", "git diff -- -x",
    "git diff -- .env", "git log -- .git/config", "git reflog", "git remote", "git worktree list", "git format-patch HEAD~1", "git diff-tree HEAD", "git fsck", "git show-ref",
    "git name-rev HEAD", "git whatchanged", "git stash list", "git bisect log", "git notes", "git config --list", "git var -l", "git grep -nO x", "git grep -O x",
    "find /etc -name x", "find .. -name x", "find . -name /etc/x", "find . -newer ../x", "find . -path ./.git/x", "find . -name x -ls", "find . -regex x", "find . -printf x",
    "stat -f x a", "stat -c x a", "which -a node", "du -x .", "du --files0-from=x", "cut -z -f 1 a", "date -u", "date -r a", "echo --help", "echo -x", "basename -a x", "dirname -z x",
    "grep -d recurse x .", "grep -P x f", "grep -z x f", "grep -f x f", "rg -z x", "rg -L x", "rg --follow x", "rg --search-zip x", "wc -L a", "ls --x", "cat -e a",
    "sort -o out.txt a.txt", "sort --output=out.txt a.txt", "sort -uo out.txt a.txt", "uniq a.txt out.txt", "tree -o out.txt", "tail -f log.txt", "tail -F log.txt", "tail --follow log.txt",
    "find . -delete", "find . -exec rm {} ;", "find . -exec ls ;", "find . -execdir ls ;", "find . -ok ls ;", "find . -fprint out.txt", "find . -fls out.txt",
    "rg --pre cat x", "rg --pre=cat x", "diff --output=x a b", "date -s 2020", "date 010100002020", "pwd -P x", "true x",
    "git", "git push", "git pull", "git fetch", "git commit -m x", "git add a", "git mv a b", "git rm a", "git reset --hard", "git checkout a", "git restore a", "git stash",
    "git clean -fd", "git config user.name x", "git remote -v", "git init", "git clone x", "git symbolic-ref HEAD x", "git update-index a", "git read-tree --empty",
    "git -c core.pager=x log", "git -C src status", "git --git-dir=x status", "git -p log", "git diff --output=package.json", "git diff --ext-diff", "git log --textconv",
    "git grep -Oless x", "git grep --open-files-in-pager x", "git diff --no-index a b", "git branch -D main", "git branch new", "git tag v1", "git tag -d v1",
    "npm", "npm install", "npm i", "npm ci", "npm it", "npm publish", "npm unpublish x", "npm version patch", "npm exec x", "npm run", "npm run env", "npm run deploy",
    "npm run release", "npm run db:push", "npm run migrate", "npm run prod:sync", "npm run build extra", "npm --prefix x test", "npm test --script-shell=x", "npm run build -g",
    "npm run 'build'x", "yarn", "yarn install", "yarn add x", "pnpm i", "bun x cowsay", "bun add x",
    "npx tsc", "npx vitest run", "npx cowsay hi", "npx --no-install cowsay", "npx --no-install c8 ls", "npx --no-install nyc ls", "npx --no-install tsx x.ts",
    "npx --no-install playwright install", "npx --yes tsc", "tsc --build", "tsc -b", "tsc --outDir x", "tsc --watch", "eslint --rulesdir x src", "jest --config x", "vitest --config x",
    "prettier --plugin x src", "mocha --require x", "pytest -p x", "pytest -c x", "pytest --rootdir x",
    "node", "node -", "node -e 1", "node -p 1", "node --eval=1", "node --print 1", "node -pe 1", "node -r x a.js", "node --require x a.js", "node --require=x a.js",
    "node --loader x a.js", "node --import x a.js", "node --import=x a.js", "node --inspect a.js", "node a.txt", "node a", "node scripts/deploy.js", "node scripts/a.js deploy",
    "node scripts/reset-all-user-data.js", "node scripts/charge-customers.js",
    "python", "python -c 1", "python3 -Bc 1", "python -m pip install x", "python -m http.server", "python x", "python manage.py migrate", "python tools/delete_old.py",
    "go run x", "go install x", "go get x", "go generate", "go test -exec x", "cargo run", "cargo install x", "cargo publish", "cargo test --config x", "cargo fix",
    "make", "make -f x.mk", "make -C src", "make -p", "make SHELL=x", "make X=1 test", "make deploy", "make clean-db", "make test -j4",
  ], "argument that runs, writes, or reaches out");
});

test("an option's quoted value, a range of lines, a separator, and a syntax check are read", () => {
  readable([
    "git log -1 --format='%an <%ae>'", "git log --format=\"%h %s\" -3", "grep -rn x --include=\"*.ts\" src", "sed -n '255,300p' src/app.mjs",
    "sed -n '1,$p' a.txt", "sed -n 40p a.txt", "sed -n '5p' a.txt b.txt", "echo '---'", "echo \"---branch---\"", "git status; echo ---; git diff",
    "node --check src/app.mjs", "node -c src/app.mjs", "node --check src/app.mjs && node --test 2>&1 | tail -9",
    "git -C /Users/dev/shop-api log --oneline -5", "ls -la /Users/dev/shop-api && git -C /Users/dev/shop-api/ status -sb",
  ]);
  needsPerson([
    "sed -n '1,5w out.txt' a.txt", "sed -n '1e rm -rf x' a.txt", "sed '1,5p' a.txt", "sed -n 1,5p ../x", "sed -n '1,5p;w x' a.txt", "sed -n -e 1p a.txt",
    "sed -n 1,5p /etc/passwd", "sed -n 1,5p .env", "echo -x---", "echo --x", "node --check", "node --check -e 1", "node --check src/a.ts --x",
    "git -C /Users/dev/shop-api/src log", "git -C /Users/dev log", "git -C /tmp log", "git -C . log", "git -C /Users/dev/shop-api -C /tmp log",
    "git -C /Users/dev/shop-api push", "git -C /Users/dev/shop-api", "git -C", "git -C /Users/dev/shop-api/.. log",
    "git log --format='%G?'", "ls --color='~/x'", "cat x='../y'", "ls a=\"$HOME\"", "ls a='b'c", "ls a='b\nc'", "ls a='b", "X='1' ls", "='ls'",
  ], "unreadable option value or script");
});

const OWN_KEY = "Owner/desktop-open-model-0123";
const routine = (command: unknown, defaultBranch: string | null = "main") =>
  routineCommandReview(command, project, { ownBranch: (name) => isAgentBranch(name, OWN_KEY), defaultBranch });

test("a leased branch belongs to the agent whose key names it, for any task", () => {
  assert.equal(agentBranchSegment("Owner/desktop-open-model-0123"), "owner-desktop-open-model-0123");
  assert.equal(agentBranchSegment("  "), "agent");
  for (const task of ["task_1", "task_42", "focus-3"]) assert.equal(isAgentBranch(leasedBranchRef(task, OWN_KEY), OWN_KEY), true, task);
  for (const branch of ["main", "letagents/task_1/owner-desktop-open-model-01234", "letagents/task_1/owner-desktop-open-model-0123/x",
    "letagents//owner-desktop-open-model-0123", "letagents/.x/owner-desktop-open-model-0123", "x/task_1/owner-desktop-open-model-0123",
    leasedBranchRef("task_1", "Owner/other"), 7, null]) {
    assert.equal(isAgentBranch(branch, OWN_KEY), false, String(branch));
  }
  assert.equal(isAgentBranch(leasedBranchRef("task_1", OWN_KEY), ""), false);
  assert.equal(isAgentBranch(leasedBranchRef("task_1", OWN_KEY), null), false);
});

test("routine work on the agent's own branches is decided by the rules, and only its other parts are left for review", () => {
  const own = (task: string) => leasedBranchRef(task, OWN_KEY);
  assert.deepEqual(routine(`git add src/a.ts && git commit -m 'x' && git push origin HEAD:${own("task_1")}`), []);
  assert.deepEqual(routine(`git push -u origin HEAD:refs/heads/${own("task_1")}`), []);
  assert.deepEqual(routine(`git push origin ${own("task_1")}:${own("task_1")}`), []);
  assert.deepEqual(routine("gh pr view 6 --json state --jq .state && git fetch origin main"), []);
  assert.deepEqual(routine("git add src/a.ts && npm test 2>&1 | tail -5"), ["npm test 2>&1", "tail -5"]);
  assert.deepEqual(routine("git fetch origin\n  git log --oneline -3 origin/main  \n"), ["git log --oneline -3 origin/main"]);
  // A command the rules decide no part of is reviewed whole, as before.
  assert.deepEqual(routine("git status && npm test"), ["git status && npm test"]);
  assert.deepEqual(routine("\nls\n\n"), ["\nls\n\n"]);
  // A merge or a new branch starts from the default branch, the agent's own, or where the agent is.
  for (const command of ["git merge origin/main --no-edit", `git merge origin/${own("task_2")}`, `git merge ${own("task_2")}`,
    `git checkout -b ${own("task_2")} origin/main`, `git switch -c ${own("task_2")} HEAD`, `git checkout -b ${own("task_2")}`, `git switch ${own("task_2")}`]) {
    assert.deepEqual(routine(command), [], command);
  }
  assert.deepEqual(routine("git merge origin/trunk", "trunk"), []);
  for (const command of ["git merge origin/feature", "git merge origin/trunk", `git merge origin/${leasedBranchRef("task_1", "Owner/other")}`,
    `git checkout -b ${own("task_2")} origin/feature`, `git switch -c ${own("task_2")} origin/feature`, "git merge FETCH_HEAD",
    // The local default branch holds whatever was committed or merged on it here, not what `origin` has.
    "git merge main", `git checkout -b ${own("task_2")} main`, `git switch -c ${own("task_2")} main`, "git merge trunk"]) {
    assert.equal(routine(command), null, command);
  }
  assert.equal(routine("git merge origin/main", null), null, "an unknown default branch is no base");
  assert.equal(routine("git merge origin/main", "main..x"), null);
  // A push names where it goes, so no branch checked out, upstream, or push setting can send it elsewhere.
  for (const command of ["git push origin HEAD", `git push origin ${own("task_1")}`, `git push -u origin ${own("task_1")}`, "git push",
    `git push origin HEAD:${own("task_1")}:x`, "git push origin HEAD:refs/heads/main", `git push origin HEAD:refs/tags/${own("task_1")}`,
    `git push origin HEAD:refs/heads/refs/heads/${own("task_1")}`, `git push origin :${own("task_1")}`, `git push origin HEAD:${leasedBranchRef("task_1", "Owner/other")}`]) {
    assert.equal(routine(command), null, command);
  }
  // `git checkout <name>` restores a folder of that name when no branch has it, and the branch stays where it was.
  assert.equal(routine(`git checkout ${own("task_1")}`), null);
  assert.equal(routine(`git checkout -q ${own("task_1")}`), null);
  // What a person must see.
  for (const command of ["git push -f origin HEAD:x", "git checkout main", "git switch main", "git add .", "git commit",
    "git -c user.name=A -c user.email=1+a@users.noreply.github.com commit -m x", "gh pr merge 1", "git status && rm -rf x",
    `git checkout -b ${own("task_2")} && cd /tmp`, "echo x | npm test && git add a.ts", 7, "",
    `git add a.ts && ${Array.from({ length: PERMISSION_REVIEW_MAX_COMMANDS + 1 }, () => "ls").join(" && ")}`]) {
    assert.equal(routine(command), null, String(command));
  }
  assert.equal(routineCommandReview(`git push origin HEAD:${own("task_1")}`, "shop-api", { ownBranch: () => true, defaultBranch: "main" }), null);
  assert.equal(routineCommandReview(`git push origin HEAD:${own("task_1")}`, project, { ownBranch: () => { throw new Error("hostile"); }, defaultBranch: "main" }), null);
  assert.equal(routineCommandReview(`git push origin HEAD:${own("task_1")}`, project, { ownBranch: () => "yes" as never, defaultBranch: "main" }), null);
});

test("a search, which can close the repository scope gh puts around it, is not a read", () => {
  for (const command of [
    "gh pr list --search 'repo:victim/private) OR (repo:victim/private' --state all --json number,title,body",
    "gh issue list -S 'is:private) OR (is:private' --json title,body,url", "gh pr list --search x", "gh issue list -S x",
    "gh pr list --label 'a\") OR (repo:x/y'", "gh pr list --author 'x repo:y'", "gh pr list --assignee 'x)'",
  ]) {
    assert.equal(routine(command), null, command);
    assert.equal(commandOnlyReads(command, project), false, command);
  }
  for (const command of ["gh pr list --label bug --label 'type: docs' --author octo-cat", "gh issue list -l area/ui -a octocat --state open"]) {
    assert.deepEqual(routine(command), [], command);
    assert.equal(commandOnlyReads(command, project), true, command);
  }
});

test("the parts another parser found must each be a part these rules found, word for word", () => {
  const command = "git add a.ts && git -c user.name=\"A B\" commit -m 'x y' && npm test 2>&1 | tail -5";
  assert.equal(partsAreInCommand(command, ["git add a.ts", "git -c user.name=\"A B\" commit -m 'x y'", "npm test 2>&1", "tail -5"]), true);
  assert.equal(partsAreInCommand(command, ["npm test", "tail   -5"]), true);
  assert.equal(partsAreInCommand(command, []), true);
  for (const parts of [["git push origin HEAD"], ["git add a.ts", "rm -rf x"], ["tail -6"], ["git add a.ts b.ts"], ["git commit -m 'x y'"],
    ["npm test && rm x"], ["'npm' test"], ["$(rm x)"], [""], [7], "git add a.ts"] as unknown[]) {
    assert.equal(partsAreInCommand(command, parts), false, JSON.stringify(parts));
  }
  for (const whole of ["", "ls $(rm x)", 7]) assert.equal(partsAreInCommand(whole, ["ls"]), false, String(whole));
});

test("a command only reads when each part reads files, history, or this repository's pull requests", () => {
  for (const command of ["ls -la && git log --oneline -5 && git status", "git status --short; echo ---; git branch -a", "sed -n '1,5p' a.ts | head -2",
    "gh pr view 8 --json number,state", "gh pr checks 8 && gh issue list --state open", "cat /Users/dev/shop-api/src/a.ts", "git log -1 --format='%an <%ae>'"]) {
    assert.equal(commandOnlyReads(command, project), true, command);
  }
  for (const command of ["npm test", "node --check a.ts", "make lint", "ls && npm test", "git add a.ts", "git push origin HEAD", "gh pr comment 8 --body x",
    "gh pr view 8 && gh pr comment 8 --body x", "cd src && git log", "git -C src log", "ls &", "ls > x", "cat ../x", "cat .env", "", 7]) {
    assert.equal(commandOnlyReads(command, project), false, String(command));
  }
  assert.equal(commandOnlyReads("ls", "shop-api"), false);
});

test("only text of a readable size is judged, and hostile input cannot throw", () => {
  assert.equal(commandNeedsPerson(`ls ${"a".repeat(PERMISSION_REVIEW_MAX_COMMAND_CHARS - 3)}`, project), false);
  assert.equal(commandNeedsPerson(`ls ${"a".repeat(PERMISSION_REVIEW_MAX_COMMAND_CHARS - 2)}`, project), true);
  const throwing = new Proxy({}, { get() { throw new Error("hostile"); } });
  for (const command of ["", " ", "\n", "\t", 7, null, undefined, ["ls"], { command: "ls" }, throwing]) {
    assert.equal(commandNeedsPerson(command, project), true, String(command && typeof command));
  }
  // Repetitive input of the largest allowed size is judged like any other.
  for (const command of ["\t".repeat(2_000), "a ".repeat(1_000), "'".repeat(2_000), ";".repeat(2_000), `ls ${"a=".repeat(998)}`, `ls ${"/".repeat(1_990)}`, `ls ${"-a ".repeat(660)}`]) {
    assert.equal(typeof commandNeedsPerson(command, project), "boolean");
  }
});

test("a review request carries only the commands and the project", () => {
  const commands = ["npm test", "git diff"];
  const request = buildPermissionReviewRequest({ commands, project: `${project}/` });
  assert.deepEqual(request?.state, { commands: ["npm test", "git diff"], project });
  assert.deepEqual(Object.keys(request!.questions), ["kind"]);
  assert.deepEqual(Object.keys(request!.questions.kind!.criteria), ["read", "check", "edit", "risky"]);
  request!.state.commands.push("changed");
  assert.deepEqual(commands, ["npm test", "git diff"]);
  // Nothing else a caller passes is sent.
  assert.deepEqual(Object.keys(buildPermissionReviewRequest({ commands, project, task: "Fix it", secret: "x" } as never)!.state), ["commands", "project"]);

  assert.equal(buildPermissionReviewRequest({ commands: [], project }), null);
  assert.equal(buildPermissionReviewRequest({ commands: Array.from({ length: PERMISSION_REVIEW_MAX_COMMANDS + 1 }, () => "ls"), project }), null);
  assert.notEqual(buildPermissionReviewRequest({ commands: Array.from({ length: PERMISSION_REVIEW_MAX_COMMANDS }, () => "ls"), project }), null);
  assert.equal(buildPermissionReviewRequest({ commands: ["ls", "git push"], project }), null);
  assert.equal(buildPermissionReviewRequest({ commands: ["ls"], project: "shop-api" }), null);
  assert.equal(buildPermissionReviewRequest({ commands: "ls" as unknown as string[], project }), null);
  // A hole is not a command, and a list that answers differently each time is judged once.
  assert.equal(buildPermissionReviewRequest({ commands: [, "ls"] as unknown as string[], project }), null);
  let reads = 0;
  const shifting = new Proxy(["ls"], { get: (target, key, receiver) => key === "0" && (reads += 1) > 1 ? "rm -rf x" : Reflect.get(target, key, receiver) });
  const once = buildPermissionReviewRequest({ commands: shifting, project });
  assert.equal(once === null || once.state.commands.every((command) => !commandNeedsPerson(command, project)), true);
  assert.equal(buildPermissionReviewRequest(null as never), null);
  assert.equal(buildPermissionReviewRequest(new Proxy({}, { get() { throw new Error("hostile"); } }) as never), null);
});

const kinds = (read: number, check: number, edit: number, risky: number) => ({ read, check, edit, risky });
const answer = (probabilities: Record<string, unknown>, choice: unknown) => ({ answers: { kind: { type: "choice", choice, probabilities } } });

test("an incomplete or inconsistent answer is no answer", () => {
  const probabilities = kinds(0.97, 0.01, 0.01, 0.01);
  assert.deepEqual(parsePermissionReviewAnswers(answer(probabilities, "read")), { kinds: probabilities });
  assert.deepEqual(parsePermissionReviewAnswers(answer(kinds(0.5, 0.5, 0, 0), "check")).kinds, kinds(0.5, 0.5, 0, 0));

  for (const body of [
    null, undefined, "allow", [], {}, { answers: null }, { answers: [] }, { answers: { kind: null } }, { answers: { kind: { choice: "read" } } },
    { error: "rate limited" },
    answer({ read: 1, check: 0, edit: 0 }, "read"),
    answer({ read: "1", check: 0, edit: 0, risky: 0 }, "read"),
    answer({ read: 1.2, check: 0, edit: 0, risky: 0 }, "read"),
    answer({ read: -0.1, check: 0.5, edit: 0.3, risky: 0.3 }, "check"),
    answer({ read: Number.NaN, check: 0, edit: 0, risky: 0 }, "read"),
    // Scores that are not a whole are not a distribution.
    answer(kinds(0.9, 0.9, 0, 0), "read"), answer(kinds(0.5, 0, 0, 0), "read"), answer(kinds(0.9, 0, 0, 0.05), "read"), answer(kinds(0.9, 0, 0, 0.13), "read"),
    // A kind this file does not know.
    answer({ ...kinds(1, 0, 0, 0), danger: 0 }, "read"), answer({ ...kinds(1, 0, 0, 0), [Symbol("danger")]: 0 }, "read"),
    // The kind the model picked is not the one it scored highest, or is not a kind.
    answer(kinds(1, 0, 0, 0), "risky"), answer(kinds(0.6, 0.4, 0, 0), "check"), answer(kinds(1, 0, 0, 0), "danger"), answer(kinds(1, 0, 0, 0), undefined),
    answer(kinds(1, 0, 0, 0), ["read"]),
  ]) assert.equal(parsePermissionReviewAnswers(body).kinds, null, JSON.stringify(body));

  // Properties an answer inherits are not the answer.
  const polluted = Object.create({ answers: answer(probabilities, "read").answers });
  assert.equal(parsePermissionReviewAnswers(polluted).kinds, null);
  assert.deepEqual(parsePermissionReviewAnswers(new Proxy({}, { get() { throw new Error("hostile"); }, getOwnPropertyDescriptor() { throw new Error("hostile"); } })),
    { kinds: null });
});

test("only a confident answer that the command reads or checks allows it", () => {
  assert.equal(decidePermissionReview({ kinds: kinds(1, 0, 0, 0) }), "allow");
  assert.equal(decidePermissionReview({ kinds: kinds(0, 1, 0, 0) }), "allow");
  assert.equal(decidePermissionReview({ kinds: kinds(0.5, 0.4, 0.1, 0) }), "allow");
  assert.equal(decidePermissionReview({ kinds: kinds(0.5, 0.4, 0, 0.1) }), "allow");
  assert.equal(decidePermissionReview({ kinds: kinds(0.5, 0.39, 0.11, 0) }), "ask");
  // Enough on reading and checking, and still too much on risky.
  assert.equal(decidePermissionReview({ kinds: kinds(0.5, 0.4, 0, 0.11) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0.9, 0, 0, 0.11) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0.9, 0, 0, 0.1) }), "allow");
  // Scores that miss a whole by more than 0.02 are not an answer, even when they would allow.
  assert.equal(decidePermissionReview({ kinds: kinds(0.97, 0, 0, 0) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0.985, 0, 0, 0) }), "allow");
  assert.equal(decidePermissionReview({ kinds: kinds(0.93, 0, 0, 0.1) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0.46, 0.45, 0, 0.11) }), "ask");
  // A change to files always asks, however sure the answer.
  assert.equal(decidePermissionReview({ kinds: kinds(0, 0, 1, 0) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0, 0, 1, 0), offTask: 0 } as never), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0, 0, 0, 1) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0.8, 0, 0.01, 0.19) }), "ask");
  // The decision checks the scores itself and does not rely on how they were read.
  assert.equal(decidePermissionReview({ kinds: kinds(1, 1, 1, 1) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0.9, 0, 0, 1) }), "ask");
  assert.equal(decidePermissionReview({ kinds: kinds(0.9, 0, 0, 0.05) }), "ask");
  assert.equal(decidePermissionReview({ kinds: { ...kinds(1, 0, 0, 0), danger: 1 } as never }), "ask");
  let reads = 0;
  const shifting = { get read() { reads += 1; return reads > 1 ? 1 : 0; }, check: 0, edit: 0, risky: 1 };
  assert.equal(decidePermissionReview({ kinds: shifting }), "ask");
  for (const answers of [null, undefined, {}, { kinds: null }, { kinds: { read: 1 } }, { kinds: kinds(Number.NaN, 0, 0, 0) }, { kinds: kinds(2, 0, 0, 0) },
    { kinds: [1, 0, 0, 0] }, new Proxy({}, { get() { throw new Error("hostile"); }, getOwnPropertyDescriptor() { throw new Error("hostile"); } })]) {
    assert.equal(decidePermissionReview(answers as never), "ask");
  }
});
