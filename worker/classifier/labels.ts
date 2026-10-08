/**
 * STM-21: the label descriptions the embedding classifier compares samples
 * with. Written from the scope rules (CLAUDE.md: one subject area, software
 * engineering; fixtures/eval/README.md "What counts as software engineering
 * here"), never from the evaluation set's entries, titles or texts, so the
 * benchmark is not scored on its own answers. No example passages or
 * centroids: each label is a short general description.
 *
 * Software engineering is split into a few areas (the README's accept list)
 * and a sample's accept score is its best match among them, because one
 * sentence can't cover "distributed systems" and "Git" equally well. Each
 * refusal label carries the phrase that fills "This looks like {detected}."
 */

export type AcceptLabel = { id: string; text: string };
export type RefuseLabel = { id: string; detected: string; text: string };

export const ACCEPT_LABELS: readonly AcceptLabel[] = [
  {
    id: "software-engineering",
    text: "Software engineering: designing, building, testing, deploying, running and maintaining software systems and applications, and writing the code for them.",
  },
  {
    id: "architecture",
    text: "Software architecture and distributed systems: services and microservices, replication, consistency, fault tolerance, scalability, message queues and system design.",
  },
  {
    id: "databases",
    text: "Databases as used by software engineers: SQL queries, indexes, transactions, schemas, storage engines, caching and data modelling for applications.",
  },
  {
    id: "testing-devops",
    text: "Software testing, continuous integration and delivery, DevOps, deployment pipelines, infrastructure as code, monitoring and incident response for production systems.",
  },
  {
    id: "security",
    text: "Application security and secure software development: vulnerabilities, authentication, input validation, threat modelling and secure coding practices.",
  },
  {
    id: "languages",
    text: "Programming languages and runtimes: syntax, type systems, compilers, interpreters, memory management, concurrency and garbage collection.",
  },
  {
    id: "algorithms",
    text: "Data structures and algorithms for programmers: complexity, sorting, hashing, trees and graphs, implemented in code.",
  },
  {
    id: "web-apis",
    text: "APIs and web protocols: HTTP, REST, browsers, JavaScript, web servers and networking for applications.",
  },
  {
    id: "practice",
    text: "Engineering practice around code: version control with Git, branches, pull requests, code review, refactoring and technical debt.",
  },
];

export const REFUSE_LABELS: readonly RefuseLabel[] = [
  { id: "cooking", detected: "cooking", text: "Cooking and food: recipes, ingredients, baking, meals, kitchen techniques and nutrition." },
  { id: "personal-finance", detected: "personal finance", text: "Personal finance: budgeting, saving, investing, taxes, mortgages, debt and retirement." },
  { id: "gardening", detected: "gardening", text: "Gardening: plants, soil, growing vegetables and flowers, lawns and garden care." },
  { id: "history", detected: "history", text: "History: historical events, wars, empires, eras, biographies and life in past centuries." },
  { id: "sports", detected: "sports", text: "Sports: teams, players, matches, athletes, training, tournaments and results." },
  { id: "fiction", detected: "fiction", text: "Fiction: a novel or short story told through characters, dialogue, scenes and plot." },
  { id: "music", detected: "music", text: "Music: songs, instruments, composers, bands, harmony, rhythm and performance." },
  { id: "biology", detected: "biology", text: "Biology: cells, genetics, organisms, evolution, ecology and anatomy." },
  { id: "medicine", detected: "health and medicine", text: "Health and medicine: diseases, symptoms, treatments, patients, doctors and wellbeing." },
  { id: "mathematics", detected: "mathematics", text: "Pure mathematics: theorems and proofs, algebra, calculus, number theory, geometry and topology." },
  { id: "physics", detected: "physics", text: "Physics: forces, energy, motion, quantum mechanics, relativity, particles and thermodynamics." },
  { id: "chemistry", detected: "chemistry", text: "Chemistry: elements, molecules, reactions, compounds and laboratory experiments." },
  {
    id: "electrical-engineering",
    detected: "electrical engineering",
    text: "Electrical engineering and electronics: circuits, voltage and current, transistors, semiconductors and signal processing.",
  },
  {
    id: "hardware",
    detected: "computer hardware",
    text: "Computer hardware: physical machines, processors and chips, vacuum tubes, wiring and building computing equipment.",
  },
  {
    id: "statistics",
    detected: "statistics",
    text: "Statistics and data analysis: probability distributions, sampling, hypothesis tests, regression and surveys.",
  },
  {
    id: "office-software",
    detected: "office software help",
    text: "Office software help: how to use spreadsheets such as Excel, formulas, word processors, slides and other end-user apps.",
  },
  {
    id: "crypto-trading",
    detected: "cryptocurrency trading",
    text: "Cryptocurrency trading: buying and selling bitcoin and tokens, prices, exchanges, speculation and investment risk.",
  },
  {
    id: "business",
    detected: "business management",
    text: "Business management: strategy, marketing, sales, customers, revenue, leadership and running an organisation.",
  },
  {
    id: "product-management",
    detected: "product management",
    text: "Product and project management: roadmaps, product strategy, user research, prioritisation, stakeholders, meetings and schedules.",
  },
  { id: "law-politics", detected: "law and politics", text: "Law and politics: legislation, regulation, government policy, courts, elections and legal rights." },
  { id: "philosophy-religion", detected: "philosophy and religion", text: "Philosophy and religion: ethics, belief, meaning, theology and schools of thought." },
  { id: "travel", detected: "travel", text: "Travel: destinations, trips, hotels, sightseeing, culture and itineraries." },
  { id: "art", detected: "art", text: "Visual art: painting, drawing, sculpture, photography, artists and art movements." },
  { id: "psychology", detected: "psychology and self-help", text: "Psychology and self-help: emotions, habits, relationships, motivation and personal growth." },
];
