'use strict';
/* Agency Swarm roster — one place that knows every agent that exists. */

const DirectorAgent = require('./director');
const ResearcherAgent = require('./researcher');
const CopywriterAgent = require('./copywriter');
const AnalystAgent = require('./analyst');
const { Agent } = require('./base');

const director = new DirectorAgent();
const specialists = [new ResearcherAgent(), new CopywriterAgent(), new AnalystAgent()];

/* Map(id → instance) of the delegatable specialists (the Director is not delegatable — it IS ARIA). */
function roster() {
  return new Map(specialists.map(a => [a.id, a]));
}

/* Everything, Director first — this is what the frontend renders as the swarm roster. */
function all() { return [director, ...specialists]; }

function list() { return all().map(a => a.card()); }

function get(id) { return all().find(a => a.id === String(id || '').toLowerCase()) || null; }

module.exports = {
  Agent, DirectorAgent, ResearcherAgent, CopywriterAgent, AnalystAgent,
  director, specialists, roster, all, list, get
};
