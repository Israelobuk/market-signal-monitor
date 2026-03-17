function Header() {
  return (
    <header className="dashboard-header">
      <div className="dashboard-header__copy">
        <h1 className="dashboard-header__title">Signal Desk</h1>
      </div>
      <div className="dashboard-header__badges" aria-label="Platform summary">
        <a href="#reddit-signals" className="dashboard-header__badge">
          Reddit signals
        </a>
      </div>
    </header>
  );
}

export default Header;
