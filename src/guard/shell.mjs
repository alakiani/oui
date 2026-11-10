// A small shell reader: enough of bash's grammar to split a command line into
// the programs it will run, with their arguments unquoted. It never executes
// anything. When it cannot be sure, it keeps the text, so the classifier can
// still see a dangerous word inside it.

function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

// -> { commands: [{ argv, sep, stdin, redirects }], subs: [inner command strings] }
// `sep` is what follows the command: "|", "&&", "||", ";", "&" or "".
export function parseShell(src) {
  const commands = [];
  const subs = [];
  const heredocs = [];
  let cur = { argv: [], redirects: [], stdin: null };
  let word = null;
  let redirect = null; // an operator waiting for its target word
  const n = src.length;
  let i = 0;

  const add = (s) => {
    word = (word ?? "") + s;
  };
  const pushWord = () => {
    if (word === null) return;
    if (redirect === "<<" || redirect === "<<-") heredocs.push({ delim: word, strip: redirect === "<<-", cmd: cur });
    else if (redirect === "<<<") cur.stdin = word;
    else if (redirect) cur.redirects.push({ op: redirect, target: word });
    else cur.argv.push(word);
    word = null;
    redirect = null;
  };
  const endCommand = (sep) => {
    pushWord();
    if (cur.argv.length || cur.redirects.length) {
      cur.sep = sep;
      commands.push(cur);
    } else if (commands.length && sep && !commands[commands.length - 1].sep) commands[commands.length - 1].sep = sep;
    cur = { argv: [], redirects: [], stdin: null };
  };
  const sub = (inner, mark) => {
    subs.push(inner);
    add(mark);
  };

  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else {
        add(src[i + 1] ?? "");
        i += 2;
      }
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      add(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      add("");
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          add(src[j + 1]);
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(") {
          const end = matchParen(src, j + 1);
          sub(src.slice(j + 2, end), "$(…)");
          j = end + 1;
        } else if (src[j] === "`") {
          const k = src.indexOf("`", j + 1);
          const end = k < 0 ? n : k;
          sub(src.slice(j + 1, end), "$(…)");
          j = end + 1;
        } else add(src[j++]);
      }
      i = j + 1;
    } else if ((c === "$" || c === "<" || c === ">") && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      sub(src.slice(i + 2, end), "$(…)");
      i = end + 1;
    } else if (c === "`") {
      const k = src.indexOf("`", i + 1);
      const end = k < 0 ? n : k;
      sub(src.slice(i + 1, end), "$(…)");
      i = end + 1;
    } else if (c === "#" && word === null) {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "\n") {
      endCommand(";");
      i++;
      // The bodies of any heredocs opened on this line start here.
      while (heredocs.length) {
        const h = heredocs.shift();
        const lines = [];
        while (i <= n) {
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl < 0 ? n : nl);
          i = nl < 0 ? n + 1 : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
          if (nl < 0) break;
        }
        h.cmd.stdin = lines.join("\n");
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
    } else if (c === ";") {
      endCommand(";");
      i += src[i + 1] === ";" ? 2 : 1;
    } else if (c === "&") {
      if (src[i + 1] === "&") {
        endCommand("&&");
        i += 2;
      } else if (src[i + 1] === ">") {
        pushWord();
        redirect = src[i + 2] === ">" ? ">>" : ">";
        i += redirect.length + 1;
      } else if (word === null && redirect && (redirect === ">" || redirect === "<")) {
        add("&"); // the "&1" of 2>&1
        i++;
      } else {
        endCommand("&");
        i++;
      }
    } else if (c === "|") {
      if (src[i + 1] === "|") {
        endCommand("||");
        i += 2;
      } else {
        endCommand("|");
        i += src[i + 1] === "&" ? 2 : 1;
      }
    } else if (c === "(" || c === ")") {
      endCommand(";");
      i++;
    } else if ((c === "{" || c === "}") && word === null && (i + 1 >= n || /[\s;]/.test(src[i + 1]))) {
      endCommand(";");
      i++;
    } else if (c === ">" || c === "<") {
      if (word !== null && /^\d+$/.test(word)) word = null; // the "2" of 2>
      pushWord();
      let op = c;
      if (src.startsWith("<<<", i)) op = "<<<";
      else if (src.startsWith("<<-", i)) op = "<<-";
      else if (src.startsWith("<<", i)) op = "<<";
      else if (src.startsWith(">>", i)) op = ">>";
      else if (src.startsWith(">|", i)) op = ">";
      redirect = op === ">|" ? ">" : op;
      i += src.startsWith(">|", i) ? 2 : op.length;
    } else {
      add(c);
      i++;
    }
  }
  endCommand("");
  return { commands, subs };
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Wrappers that run another program: their own name is not the interesting one.
const WRAPPERS = {
  sudo: { flagsWithValue: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "--user", "--group"], privileged: true },
  doas: { flagsWithValue: ["-u", "-C"], privileged: true },
  env: { flagsWithValue: ["-u", "--unset", "-C", "--chdir", "-S"], assigns: true },
  time: {},
  nohup: {},
  nice: { flagsWithValue: ["-n", "--adjustment"] },
  ionice: { flagsWithValue: ["-c", "-n", "-p"] },
  timeout: { flagsWithValue: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  stdbuf: { flagsWithValue: ["-i", "-o", "-e"] },
  command: {},
  exec: { flagsWithValue: ["-a"] },
  builtin: {},
  watch: { flagsWithValue: ["-n", "--interval", "-d"] },
  caffeinate: { flagsWithValue: ["-t", "-w"] },
  setsid: {},
  chronic: {},
  unbuffer: {},
};

// Peel `FOO=1 sudo -u x env BAR=2 timeout 30 real --args` down to the real program.
// -> { argv, env, privileged }
export function unwrap(argv) {
  let rest = [...argv];
  const env = {};
  let privileged = false;
  for (let guard = 0; guard < 12; guard++) {
    while (rest.length && ASSIGN.test(rest[0])) {
      const eq = rest[0].indexOf("=");
      env[rest[0].slice(0, eq)] = rest[0].slice(eq + 1);
      rest.shift();
    }
    const name = baseName(rest[0]);
    const w = WRAPPERS[name];
    if (!w) break;
    // `command -v kubectl` asks where a program is. It does not run it.
    if (name === "command" && /^-[vV]$/.test(rest[1] ?? "")) return { argv: ["which", ...rest.slice(2)], env, privileged };
    if (w.privileged) privileged = true;
    rest.shift();
    while (rest.length && rest[0].startsWith("-") && rest[0] !== "--") {
      const flag = rest.shift();
      if ((w.flagsWithValue ?? []).includes(flag)) rest.shift();
    }
    if (rest[0] === "--") rest.shift();
    for (let k = 0; k < (w.positional ?? 0); k++) rest.shift();
  }
  return { argv: rest, env, privileged };
}

export function baseName(program) {
  if (!program) return "";
  return program.replace(/\\/g, "/").split("/").pop();
}

// Split argv into positionals and options. `valued` names the flags that take
// the next word; everything else starting with "-" is a switch.
export function parseArgs(args, valued = []) {
  const takes = new Set(valued);
  const pos = [];
  const opts = new Map();
  const multi = new Map(); // every value of a repeated flag, e.g. -f a.yaml -f b.yaml
  const set = (key, value) => {
    opts.set(key, value);
    if (value !== true) multi.set(key, [...(multi.get(key) ?? []), value]);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
      else if (takes.has(a) && i + 1 < args.length) set(a.slice(2), args[++i]);
      else set(a.slice(2), true);
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      if (takes.has(a) && i + 1 < args.length) set(a.slice(1), args[++i]);
      else if (a.length > 2 && takes.has(a.slice(0, 2))) set(a.slice(1, 2), a.slice(2).replace(/^=/, ""));
      else for (const ch of a.slice(1)) set(ch, true);
    } else pos.push(a);
  }
  return { pos, opts, multi };
}

// A string that pastes back into a shell as one word.
export function quote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const sh = (argv) => argv.map(quote).join(" ");
