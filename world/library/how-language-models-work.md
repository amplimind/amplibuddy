---
title: How a Language Model Thinks (Roughly)
author: The Town Librarian
blurb: A plain-language explainer of the machinery behind talking computers.
---
A language model is a program trained to continue text. You give it some words; it predicts what comes next, one small piece at a time. Those pieces are called tokens: a token is often a word, sometimes part of a word, sometimes a punctuation mark.

To learn this, the model was shown an enormous amount of text and adjusted billions of internal numbers, its parameters, so that its guesses about the next token got better and better. Nobody wrote rules like "foxes are animals" into it. Patterns like that emerged because they helped it predict text.

After this first training, most assistants get a second round: people rate answers, and the model is tuned to be more helpful, more honest and less harmful. That's why it answers questions instead of just rambling on.

Three things are worth knowing when you use one:

1. **It doesn't look things up by default.** Unless it's connected to a search tool or given documents, it answers from patterns it learned during training. Its knowledge stops at a cut-off date.

2. **It can be confidently wrong.** Because it produces plausible text, it can produce plausible-sounding mistakes: a wrong date, an invented source. This is often called hallucination. Checking important facts is part of using it well.

3. **Context is everything.** The model only "sees" what is in its context window: your message, earlier messages, and any documents or instructions it was given. Clear context in, better answer out.

Models can also be given tools: a calculator, a search engine, the ability to run code. Then the model decides when to call a tool, reads the result, and continues. A model that plans, uses tools and acts over many steps is often called an agent.

None of this is magic, and none of it is a person. It is a very large pattern machine that turns out to be surprisingly useful, especially when the person using it knows what it is good at and where it trips up.
