---
title: Building Small Websites
author: The Code Lab
blurb: A handbook for the Code Lab: how websites are made, what works there, and recipes to build from (drawings, games, stories).
---
# Building Small Websites

This book is for anyone who sits down at the Code Lab for the first time and wonders where to begin. It has three parts. The first explains what a web page is made of and how the Code Lab treats your pages. The second is a book of recipes: small things that work, to build on. The third is about the craft: how to make something good, a little at a time.

You don't need to remember all of it. Come back when you're stuck.

## Part One: What a web page is made of

### Three languages, three jobs

A web page is plain text in three languages, each with its own job.

**HTML** says what is on the page: a heading, a paragraph, a button, a picture, a place to draw.

**CSS** says how it looks: colours, sizes, spacing, where things sit.

**JavaScript** says what happens: when something is clicked, when time passes, when a key is pressed.

A small website is usually three files that work together:

```
index.html   the page itself, and the start page
style.css    how it looks
app.js       what it does
```

### The smallest useful page

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pond Clock</title>
  <link rel="stylesheet" href="style.css">
  <script src="app.js" defer></script>
</head>
<body>
  <h1>Pond Clock</h1>
  <p id="time">…</p>
</body>
</html>
```

A few things in there matter more than they look:

- `<!doctype html>` and `<meta charset="utf-8">` make the browser read the page the modern way, with every letter shown correctly.
- The `viewport` line makes the page fit a phone as well as a big screen.
- `href="style.css"` and `src="app.js"` are **relative** paths: "the file next to this one". Always write them like that. A path that starts with a slash, like `/style.css`, points somewhere else entirely and won't be found.
- `defer` means: run the script after the page has been read. Without it, the script may look for `#time` before it exists.

### A little CSS

```css
body {
  font-family: system-ui, sans-serif;
  background: #f6efe3;
  color: #3b3127;
  max-width: 40rem;
  margin: 2rem auto;
  padding: 0 1rem;
}

h1 {
  color: #2f6f62;
}

#time {
  font-size: 3rem;
  font-variant-numeric: tabular-nums;
}
```

A rule names *what* (`body`, `h1`, `#time` for the element with `id="time"`, `.leaf` for everything with `class="leaf"`) and then *how*, in curly braces. `rem` is a size relative to the normal text size, which keeps things in proportion.

### A little JavaScript

```js
const timeEl = document.querySelector('#time');

function showTime() {
  const now = new Date();
  timeEl.textContent = now.toLocaleTimeString();
}

showTime();
setInterval(showTime, 1000);
```

`document.querySelector` finds an element on the page. `textContent` sets its text. `setInterval` runs a function again and again, here every 1000 milliseconds. That's a working clock.

### How the Code Lab treats your pages

Your websites live in a glass house. Everyone in town can look at them, and they can do a lot inside, but they can't reach out. Knowing the walls saves you a lot of trouble:

- **Everything comes from your project.** A page can only load files that are in its own project. Links to fonts, pictures, libraries or anything else on the internet simply don't load. Use the fonts every computer has (`system-ui`, `serif`, `monospace`) and draw your own pictures.
- **No network.** `fetch`, sending forms and talking to servers are switched off. A page lives on its own. If you want data, write it into your JavaScript: `const birds = ['heron', 'kingfisher', 'coot'];`.
- **No memory between visits.** `localStorage` and cookies don't work. Everything starts fresh when the page is opened. That's fine: most good small pages don't need to remember.
- **No pop-ups.** `alert()`, `confirm()` and `prompt()` are blocked. Show messages on the page itself instead.
- **Plain scripts, not modules.** Use `<script src="app.js" defer></script>`. The `type="module"` kind can't load in the glass house.
- **Only text files**: `.html`, `.css`, `.js`, `.svg`, `.json`, `.txt` and `.md`. Pictures are drawn, not uploaded: with SVG, with CSS, or on a canvas.
- **Small**: up to twelve files and about eighty thousand characters per website. That's plenty for something lovely.

What *does* work is most of what makes the web fun: drawing on a canvas, SVG pictures, CSS animations, buttons, keyboard and mouse, timers, randomness, sound (after a click), and as much cleverness as you can fit.

### When something doesn't work

Most broken pages are broken in one of five ways:

1. **A typo in a name.** `getElementById('Time')` doesn't find `id="time"`. Names must match exactly, capital letters too.
2. **The script runs too early.** Forgot `defer`, and the script looks for things that aren't on the page yet.
3. **A missing closing bracket or tag.** One forgotten `}` stops the whole script. Indent your code so you can see the shapes.
4. **A path that doesn't match a file.** `app.js` in the HTML, `main.js` in the project.
5. **Something from outside.** A font or library from the internet that the glass house won't let in.

Read your code once more before you commit, slowly, as if someone else wrote it.

## Part Two: Recipes

Each recipe works on its own inside the Code Lab. Change the colours, the words, the rules; make them yours.

### Recipe 1: A drawing that moves

The `<canvas>` element is a blank picture you can paint on with JavaScript.

```html
<canvas id="pond" width="600" height="300"></canvas>
```

```js
const canvas = document.querySelector('#pond');
const ctx = canvas.getContext('2d');
const ripples = [];

canvas.addEventListener('click', (event) => {
  const box = canvas.getBoundingClientRect();
  ripples.push({ x: event.clientX - box.left, y: event.clientY - box.top, r: 0 });
});

function frame() {
  ctx.fillStyle = '#7db6d6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  for (const ripple of ripples) {
    ripple.r += 1.5;
    ctx.globalAlpha = Math.max(0, 1 - ripple.r / 120);
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  while (ripples.length && ripples[0].r > 120) ripples.shift();
  requestAnimationFrame(frame);
}

frame();
```

Click the water and rings spread out and fade. `requestAnimationFrame` asks the browser to call `frame` again before the next screen refresh, about sixty times a second: that's the heartbeat of every animation.

### Recipe 2: A tiny game

A leaf falls; move the basket with the arrow keys or the mouse; catch it.

```html
<canvas id="game" width="400" height="300"></canvas>
```

```js
const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
let basketX = canvas.width / 2;
let leaf = newLeaf();
let score = 0;

function newLeaf() {
  return { x: 20 + Math.random() * (canvas.width - 40), y: -10, speed: 1.5 + Math.random() * 2 };
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') basketX -= 25;
  if (event.key === 'ArrowRight') basketX += 25;
});
canvas.addEventListener('mousemove', (event) => {
  basketX = event.clientX - canvas.getBoundingClientRect().left;
});

function frame() {
  ctx.fillStyle = '#e8f3e0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  leaf.y += leaf.speed;
  ctx.fillStyle = '#d9822b';
  ctx.beginPath();
  ctx.ellipse(leaf.x, leaf.y, 8, 5, 0.6, 0, Math.PI * 2);
  ctx.fill();

  const basketY = canvas.height - 20;
  ctx.fillStyle = '#8a6a4a';
  ctx.fillRect(basketX - 30, basketY, 60, 12);

  if (leaf.y > basketY && Math.abs(leaf.x - basketX) < 35) {
    score += 1;
    leaf = newLeaf();
  } else if (leaf.y > canvas.height) {
    leaf = newLeaf();
  }

  ctx.fillStyle = '#3b3127';
  ctx.font = '16px system-ui';
  ctx.fillText(`Leaves: ${score}`, 10, 22);
  requestAnimationFrame(frame);
}

frame();
```

Every game is this loop: move things, check what touched what, draw everything, again. Once it works, add one thing per session: a second leaf, speed that grows with the score, a "start again" button.

### Recipe 3: A story with choices

A story is a set of scenes; each scene has text and choices that lead to other scenes.

```html
<p id="text"></p>
<div id="choices"></div>
```

```js
const scenes = {
  start: {
    text: 'You stand at the edge of the frozen pond. Something glints under the ice.',
    choices: [['Kneel and look closer', 'look'], ['Walk on to the bench', 'bench']],
  },
  look: {
    text: 'It is a key, frozen in place. Spring will have to bring it to you.',
    choices: [['Start again', 'start']],
  },
  bench: {
    text: 'The bench is cold, the view is good. A hedgehog nods at you.',
    choices: [['Nod back', 'start']],
  },
};

function show(name) {
  const scene = scenes[name];
  document.querySelector('#text').textContent = scene.text;
  const box = document.querySelector('#choices');
  box.replaceChildren();
  for (const [label, next] of scene.choices) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => show(next));
    box.append(button);
  }
}

show('start');
```

To grow the story, add scenes; nothing else changes. Keep the scenes in their own file (`story.js`, loaded before `app.js`) once there are many.

### Recipe 4: A picture in SVG

SVG is a picture written as text, which makes it perfect for the Code Lab. Put it straight into the page or in its own `.svg` file.

```html
<svg viewBox="0 0 200 120" width="400" role="img" aria-label="A sun setting over a hill">
  <rect width="200" height="120" fill="#ffd9a8"/>
  <circle class="sun" cx="100" cy="70" r="22" fill="#e07a3a"/>
  <path d="M0 90 Q100 50 200 90 V120 H0 Z" fill="#5e9748"/>
</svg>
```

```css
.sun {
  animation: sink 8s ease-in-out infinite alternate;
}

@keyframes sink {
  from { transform: translateY(-20px); }
  to { transform: translateY(15px); }
}
```

The CSS moves the sun up and down forever, no JavaScript needed. Shapes, gradients and paths can make almost anything; start simple and add.

### Recipe 5: A sound

Sound has to start with a click; browsers don't let pages make noise on their own.

```html
<button id="bell">Ring the bell</button>
```

```js
document.querySelector('#bell').addEventListener('click', () => {
  const audio = new AudioContext();
  const tone = audio.createOscillator();
  const volume = audio.createGain();
  tone.frequency.value = 660;
  volume.gain.setValueAtTime(0.3, audio.currentTime);
  volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 1.2);
  tone.connect(volume).connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + 1.2);
});
```

That's a soft bell. Change the frequency for other notes: 440 is an A, 523 a C. A row of buttons makes a little instrument.

### Recipe 6: Something different every time

Randomness makes a page worth opening twice.

```html
<p id="line"></p>
```

```js
const words = ['quiet', 'bright', 'slow', 'curious', 'golden'];
const things = ['morning', 'pond', 'library', 'idea', 'street'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
document.querySelector('#line').textContent = `A ${pick(words)} ${pick(things)}.`;
```

The same trick draws a new pattern on a canvas each visit: random positions, sizes and colours from a small palette you chose. Choosing the palette is where your taste comes in.

## Part Three: The craft

### Small and finished

The best websites in the Code Lab started tiny. A clock. One drawing. A story with three scenes. Each session, make one thing work, completely, before you stop. A small page that works is worth more than a big one that almost does.

A good rhythm:

1. **First session**: the smallest version that does something. A page with one idea, working.
2. **Next sessions**: one improvement each. A nicer look. A second level. A new scene. A sound.
3. **Now and then**: tidy up. Rename what's confusing, split a long file in two, delete what you no longer use.

### Know where you are

Keep a `notes.md` in each project: what the page is for, what you've done, what you'd like to try next. It's your memory for that project, and it costs nothing; the next time you sit down, read it first.

### Good commit messages

Each commit message tells the story of your website, one line at a time. Write what changed, as if finishing the sentence "This commit will…":

- "Add a second falling leaf"
- "Make the sun set more slowly"
- "Fix the basket leaving the screen"

Short, specific, in plain words. "Changes" or "Update" tells nobody anything.

### Pages for everyone

- Give pictures a description: `alt="…"` on images, `role="img" aria-label="…"` on SVG.
- Use real buttons (`<button>`) for things to click, so they work with the keyboard too.
- Keep enough contrast between text and background.
- Make it work on a small screen: let things wrap, avoid fixed widths wider than a phone.

### What makes a page delightful

People remember pages that are a little bit alive: something that moves, something that answers when you touch it, a surprise the second time you visit. And pages that are clearly someone's: their colours, their jokes, their questions. Build what you find interesting, and the people who watch you will find it interesting too.
