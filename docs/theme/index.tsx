import { useEffect, useRef, useState } from "react";
import "./index.css";

export * from "@rspress/core/theme-original";

// Icon components
const GitHubIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

const CopyIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

const CheckIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const ExternalLinkIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" x2="21" y1="14" y2="3" />
  </svg>
);

// Features data - 3 key differentiators
const features = [
  {
    title: "Any ACP Agent",
    description:
      "Works with any agent that implements the Agent Control Protocol. Claude Code, Gemini CLI, OpenCode, and more.",
  },
  {
    title: "Deploy Anywhere",
    description:
      "Runs anywhere Node.js runs. Local machine, remote server, or even Termux on Android.",
  },
  {
    title: "Operates as You",
    description:
      "Agents browse the web using your real browser session. Same cookies, same identity—perfect for authenticated crawling.",
  },
];

// Agent logo paths
const agentLogos = {
  ClaudeCode: "/chrome-acp/logos/claude.svg",
  GeminiCLI: "/chrome-acp/logos/gemini.svg",
  OpenCode: "/chrome-acp/logos/opencode.svg",
  CodexCLI: "/chrome-acp/logos/openai.svg",
};

// Agents data - from ACP registry (https://zed.dev/acp)
const agents = [
  {
    name: "Claude Code",
    description: "Anthropic's agentic coding tool.",
    logo: agentLogos.ClaudeCode,
    link: "https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview",
  },
  {
    name: "Gemini CLI",
    description: "Google's AI agent for the command line.",
    logo: agentLogos.GeminiCLI,
    link: "https://github.com/google-gemini/gemini-cli",
  },
  {
    name: "OpenCode",
    description: "Open-source terminal-based AI coding assistant.",
    logo: agentLogos.OpenCode,
    link: "https://github.com/opencode-ai/opencode",
  },
  {
    name: "Codex CLI",
    description: "OpenAI's lightweight coding agent.",
    logo: agentLogos.CodexCLI,
    link: "https://github.com/openai/codex",
  },
];

export function HomeLayout() {
  const [copied, setCopied] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setIsVisible(true);
    const video = videoRef.current;
    if (video) {
      video.muted = true;
      video.play().catch(() => {});
    }
  }, []);

  const installCommand = `npm i -g @chrome-acp/proxy-server @zed-industries/claude-code-acp`;
  const startCommand = `acp-proxy --no-auth claude-code-acp`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(`${installCommand}\n${startCommand}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="landing-page">
      {/* Hero Section - Zed style: big bold title */}
      <section className={`hero-section ${isVisible ? "visible" : ""}`}>
        <div className="hero-content">
          <h1 className="hero-title">Browser Control for AI Agents</h1>
          <p className="hero-subtitle">
            Chat with AI agents and give them the power to see and interact with
            your browser. Built on the{" "}
            <a
              href="https://zed.dev/acp"
              target="_blank"
              rel="noopener noreferrer"
            >
              Agent Control Protocol
            </a>
            .
          </p>
          <div className="hero-actions">
            <a
              href="/chrome-acp/getting-started/quick-start"
              className="btn-primary"
            >
              Get Started
            </a>
            <a
              href="https://github.com/anthropics/anthropic-quickstarts/tree/main/chrome-acp"
              className="btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubIcon />
              <span>GitHub</span>
            </a>
          </div>
          <p className="hero-note">
            Works with Chrome, Brave, Edge, and any Chromium browser
          </p>
        </div>
      </section>

      {/* Video Showcase - Zed style: prominent video with subtle shadow */}
      <section className={`showcase-section ${isVisible ? "visible" : ""}`}>
        <div className="showcase-container">
          <video
            ref={videoRef}
            src="/chrome-acp/promo.mp4"
            autoPlay
            muted
            playsInline
            controls
            className="showcase-video"
          />
        </div>
      </section>

      {/* Features Section - Zed style: 3-column clean grid */}
      <section className="features-section">
        <div className="features-container">
          <h2 className="section-title">A New Standard for Browser Control</h2>
          <p className="section-subtitle">
            Chrome ACP enables any agent to interact with your browser through
            the Agent Control Protocol.
          </p>
          <div className="features-grid">
            {features.map((feature) => (
              <div key={feature.title} className="feature-card">
                <h3 className="feature-title">{feature.title}</h3>
                <p className="feature-description">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agents Section - Zed style: card grid like "Agents on ACP" */}
      <section className="agents-section">
        <div className="agents-container">
          <h2 className="section-title">Compatible ACP Agents</h2>
          <p className="section-subtitle">
            Connect any agent that speaks ACP to control your browser.
          </p>
          <div className="agents-grid">
            {agents.map((agent) => (
              <a
                key={agent.name}
                href={agent.link}
                target="_blank"
                rel="noopener noreferrer"
                className="agent-card"
              >
                <div className="agent-header">
                  <img
                    src={agent.logo}
                    alt={agent.name}
                    className="agent-icon"
                  />
                  <h3 className="agent-name">{agent.name}</h3>
                  <ExternalLinkIcon />
                </div>
                <p className="agent-description">{agent.description}</p>
              </a>
            ))}
          </div>
          <p className="agents-more">
            And many more from the{" "}
            <a
              href="https://zed.dev/acp"
              target="_blank"
              rel="noopener noreferrer"
            >
              ACP ecosystem
            </a>
            .
          </p>
        </div>
      </section>

      {/* Install Section - Zed style: clean terminal card */}
      <section className="install-section">
        <div className="install-container">
          <h2 className="section-title">Get Started in Seconds</h2>
          <p className="section-subtitle">
            Install globally and start the proxy server
          </p>
          <div className="install-card">
            <div className="install-header">
              <span className="install-label">Terminal</span>
              <button className="copy-button" onClick={handleCopy}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                <span>{copied ? "Copied!" : "Copy"}</span>
              </button>
            </div>
            <div className="install-code">
              <div className="code-line">
                <span className="code-comment"># Install the proxy server</span>
              </div>
              <div className="code-line">
                <span className="code-prompt">$</span>
                <span className="code-command">{installCommand}</span>
              </div>
              <div className="code-line">
                <span className="code-comment"># Start with your agent</span>
              </div>
              <div className="code-line">
                <span className="code-prompt">$</span>
                <span className="code-command">{startCommand}</span>
              </div>
            </div>
            <div className="install-footer">
              Then open{" "}
              <a
                href="http://localhost:9315"
                target="_blank"
                rel="noopener noreferrer"
              >
                http://localhost:9315
              </a>{" "}
              in your browser
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section - Zed style: simple and bold */}
      <section className="cta-section">
        <div className="cta-container">
          <h2 className="cta-title">
            Ready to give your AI browser superpowers?
          </h2>
          <div className="cta-actions">
            <a
              href="/chrome-acp/getting-started/quick-start"
              className="btn-primary btn-large"
            >
              Get Started
            </a>
          </div>
        </div>
      </section>

      {/* Footer - Zed style: minimal */}
      <footer className="landing-footer">
        <div className="footer-container">
          <p className="footer-text">
            Chrome ACP · Open Source under MIT License
          </p>
        </div>
      </footer>
    </div>
  );
}
