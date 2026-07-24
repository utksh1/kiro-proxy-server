/**
 * Chinese translation
 */

const zh = {
  // Universal
  common: {
    confirm: 'confirm',
    cancel: 'Cancel',
    save: 'save',
    delete: 'delete',
    edit: 'edit',
    add: 'Add to',
    close: 'closure',
    loading: 'loading...',
    success: 'success',
    error: 'mistake',
    warning: 'warn',
    info: 'hint',
    yes: 'yes',
    no: 'no',
    enabled: 'Already turned on',
    disabled: 'Closed',
    all: 'all',
    none: 'none',
    search: 'search',
    filter: 'filter',
    sort: 'sort',
    refresh: 'refresh',
    copy: 'copy',
    copied: 'Copied',
    import: 'import',
    export: 'Export',
    backup: 'backup',
    restore: 'recover',
    reset: 'reset',
    apply: 'application',
    selected: 'Selected',
    total: 'total',
    unknown: 'unknown'
  },

  // navigation
  nav: {
    home: 'Home page',
    accounts: 'Account management',
    machineId: 'machine code',
    kiroSettings: 'Kiro set up',
    proxy: 'API Anti-generational',
    kproxy: 'K-Proxy',
    proxyPool: 'proxy pool',
    webhooks: 'Webhook',
    diagnose: 'One-click diagnosis',
    configSync: 'Configuration synchronization',
    register: 'register',
    subscription: 'Bulk subscription',
    logs: 'System log',
    settings: 'set up',
    about: 'about'
  },

  // Home page
  home: {
    title: 'Home page',
    totalAccounts: 'Total number of accounts',
    activeAccounts: 'normal',
    errorAccounts: 'abnormal',
    totalQuota: 'total amount',
    currentAccount: 'Current account',
    noCurrentAccount: 'No account selected',
    selectAccount: 'Please choose an account to use',
    subscription: 'Subscription plan',
    usage: 'Usage',
    daysRemaining: 'Remaining {days} sky',
    expiresOn: 'Expiration time {date}',
    quickActions: 'Quick operation',
    switchAccount: 'Switch account',
    refreshToken: 'refresh Token',
    checkStatus: 'check status',
    welcome: {
      title: 'Welcome Kiro Account manager',
      description: 'a powerful Kiro IDE Multiple account management tools',
      features: {
        multiAccount: 'Manage multiple Kiro account',
        autoRefresh: 'Token Automatically refresh before expiration',
        machineId: 'Machine code management to prevent bans',
        themes: '32 theme colors available'
      }
    }
  },

  // Account management page
  accounts: {
    title: 'Account management',
    addAccount: 'Add account',
    batchAdd: 'Add in batches',
    searchPlaceholder: 'Search account...',
    noAccounts: 'No account yet',
    addFirstAccount: 'Add your first account to get started',
    totalAccounts: 'common {count} accounts',
    selectedCount: 'Selected {count} indivual',
    batchActions: 'Batch operation',
    setGroup: 'Set up groups',
    setTags: 'Set label',
    batchRefresh: 'Batch refresh',
    batchCheck: 'Batch inspection',
    batchDelete: 'Batch delete',
    confirmDelete: 'Are you sure you want to delete this account?',
    confirmBatchDelete: 'Confirm to delete {count} An account?',
    filters: {
      all: 'all',
      active: 'normal',
      error: 'abnormal',
      expiring: 'Expires soon',
      noGroup: 'Not grouped'
    },
    sort: {
      email: 'Mail',
      usage: 'Dosage',
      addedAt: 'Add time',
      lastChecked: 'final check'
    },
    card: {
      usage: 'Usage',
      base: 'Base',
      trial: 'try out',
      tokenExpiry: 'Token: {time}',
      tokenExpired: 'Token: Expired',
      lastChecked: 'examine: {time}',
      neverChecked: 'never checked',
      switchTo: 'Switch to this account',
      current: 'current',
      banned: 'Banned',
      verified: 'Verified'
    }
  },

  // Add account dialog box
  addAccount: {
    title: 'Add account',
    description: 'add new Kiro account',
    tabs: {
      ssoToken: 'SSO Token',
      oidcCredentials: 'OIDC certificate',
      socialLogin: 'social login',
      batchImport: 'Batch import'
    },
    ssoToken: {
      label: 'SSO Token',
      placeholder: 'paste here SSO Token...',
      hint: 'Log in from Kiro After obtaining the browser developer tools'
    },
    oidc: {
      authMethod: 'Authentication method',
      builderId: 'Builder ID (IdC)',
      social: 'GitHub / Google',
      refreshToken: 'Refresh Token',
      refreshTokenPlaceholder: 'Paste Refresh Token...',
      clientId: 'Client ID',
      clientSecret: 'Client Secret',
      region: 'AWS area',
      socialHint: 'Social login not required Client ID and Client Secret',
      selectProvider: 'Choose a provider'
    },
    social: {
      title: 'social login',
      description: 'use Google or GitHub Log in',
      google: 'use Google Log in',
      github: 'use GitHub Log in',
      waiting: 'Waiting for authorization...',
      success: 'Authorization successful!',
      failed: 'Authorization failed'
    },
    batch: {
      title: 'Batch import',
      description: 'Import multiple accounts at once',
      format: 'Format: One account per line',
      placeholder: 'refreshToken\nor\nrefreshToken,clientId,clientSecret\nor\nJSON Format',
      importing: 'Importing {current}/{total}...',
      result: 'Import completed:{success} success,{failed} fail'
    },
    verifying: 'Verifying...',
    verifySuccess: 'Verification successful',
    verifyFailed: 'Authentication failed'
  },

  // Edit account dialog box
  editAccount: {
    title: 'Edit account',
    description: 'Modify account configuration or update credentials',
    nickname: 'Account alias',
    nicknamePlaceholder: 'Give this account a memorable name',
    credentials: 'Credential configuration',
    socialCredentials: 'Social login credentials',
    oidcCredentials: 'OIDC Credential configuration',
    importFromLocal: 'Import from local',
    verifyAndRefresh: 'Verify and refresh credential information',
    saveChanges: 'Save changes',
    accountStatus: 'Current account status',
    verified: 'Verified',
    error: 'abnormal'
  },

  // Machine code management page
  machineId: {
    title: 'Machine code management',
    description: 'Manage device identifiers to prevent account association bans',
    current: 'Current machine code',
    original: 'original backup',
    noBackup: 'No backup',
    backupTime: 'Backup time: {time}',
    actions: {
      copy: 'copy',
      generate: 'randomly generated',
      custom: 'Customize',
      restore: 'restore original',
      backupToFile: 'Backup to file',
      restoreFromFile: 'Recover from files'
    },
    automation: {
      title: 'Automation settings',
      autoSwitch: 'Automatically switch machine code',
      autoSwitchDesc: 'Automatically change the machine code when switching accounts',
      bindToAccount: 'Bind machine code to account',
      bindToAccountDesc: 'Each account uses independent machine code',
      useBinded: 'Use bound machine code',
      useBindedDesc: 'Use the bound machine code when switching accounts'
    },
    accountBindings: 'Account machine code binding',
    history: 'Modification history',
    requiresAdmin: 'Requires administrator rights',
    restartAsAdmin: 'Restart as administrator',
    platformInfo: {
      title: 'Platform description',
      windows: 'Windows: Modify registry MachineGuid',
      macos: 'macOS: Revise IOPlatformUUID',
      linux: 'Linux: Revise /etc/machine-id'
    }
  },

  // settings page
  settings: {
    title: 'set up',
    language: {
      title: 'language',
      description: 'Select display language',
      auto: 'automatic (Follow the system)',
      en: 'English',
      zh: 'Simplified Chinese',
      customFile: 'Custom translation files',
      loadCustom: 'Load customization',
      customHint: 'Load custom translations from local JSON document'
    },
    theme: {
      title: 'theme',
      description: 'Customize appearance',
      color: 'theme color',
      darkMode: 'dark mode',
      lightMode: 'light mode'
    },
    privacy: {
      title: 'privacy',
      description: 'Privacy protection settings',
      privacyMode: 'privacy mode',
      privacyModeDesc: 'Hide email,Token sensitive information'
    },
    autoRefresh: {
      title: 'Auto refresh',
      description: 'Token Auto refresh settings',
      enabled: 'Auto refresh',
      enabledDesc: 'Token Automatically refresh before expiration and update account information synchronously',
      interval: 'Check interval',
      intervalDesc: 'How often should you check your account status?',
      concurrency: 'Number of concurrent refreshes',
      concurrencyDesc: 'Number of accounts refreshed at the same time',
      syncInfo: 'Synchronously detect account information',
      syncInfoDesc: 'refresh Token Detect usage, subscription, and ban status simultaneously',
      minutes: '{n} minute'
    },
    autoSwitch: {
      title: 'Automatic number change',
      description: 'Automatically switch accounts when the balance is insufficient',
      enabled: 'Automatic number change',
      enabledDesc: 'Automatically switch to other available accounts when the current account balance is insufficient',
      threshold: 'Balance threshold',
      thresholdDesc: 'Switch when the balance is lower than this value',
      interval: 'Check interval',
      intervalDesc: 'How often to check your balance'
    },
    proxy: {
      title: 'acting',
      description: 'Network proxy settings',
      enabled: 'Enable proxy',
      url: 'proxy address',
      urlPlaceholder: 'http://host:port or socks5://host:port',
      urlHint: 'support HTTP、HTTPS、SOCKS5 protocol'
    },
    data: {
      title: 'Data management',
      description: 'import/Export account data',
      export: 'Export data',
      import: 'Import data',
      exportHint: 'Export account to JSON、TXT、CSV or clipboard',
      importHint: 'from JSON File import account'
    },
    batchImport: {
      title: 'Batch import',
      concurrency: 'Import concurrency count',
      concurrencyDesc: 'Number of accounts imported at the same time'
    },
    dangerZone: {
      title: 'Danger area',
      clearData: 'Clear all data',
      clearDataDesc: 'Delete all accounts and settings',
      clearDataConfirm: 'Are you sure you want to clear it? This action cannot be undone.',
      clearDataButton: 'Clear all data'
    }
  },

  // About page
  about: {
    title: 'about',
    version: 'Version {version}',
    description: 'a powerful Kiro IDE Multiple account management tools',
    features: 'Features',
    techStack: 'technology stack',
    author: 'author',
    github: 'GitHub',
    checkUpdate: 'Check for updates',
    upToDate: 'Currently the latest version',
    newVersion: 'new version found: {version}',
    download: 'download',
    releaseNotes: 'Update instructions'
  },

  // state
  status: {
    active: 'normal',
    error: 'abnormal',
    banned: 'Banned',
    expired: 'Expired',
    unknown: 'unknown'
  },

  // Subscription type
  subscription: {
    free: 'Free version',
    pro: 'Professional version',
    enterprise: 'Enterprise Edition',
    teams: 'Team Edition',
    unknown: 'unknown'
  },

  // time
  time: {
    justNow: 'just',
    minutesAgo: '{n} minutes ago',
    hoursAgo: '{n} hours ago',
    daysAgo: '{n} days ago',
    expired: 'Expired',
    remaining: 'Remaining {time}'
  },

  // mistake
  errors: {
    networkError: 'Network error, please check network connection',
    authError: 'Authentication failed',
    tokenExpired: 'Token Expired, please refresh',
    accountBanned: 'Account has been banned',
    invalidCredentials: 'Invalid voucher',
    importFailed: 'Import failed',
    exportFailed: 'Export failed',
    saveFailed: 'Save failed',
    loadFailed: 'Loading failed',
    unknownError: 'An unknown error occurred'
  },

  // information
  messages: {
    accountAdded: 'Account added successfully',
    accountDeleted: 'Account deleted successfully',
    accountUpdated: 'Account updated successfully',
    tokenRefreshed: 'Token Refresh successful',
    settingsSaved: 'Settings saved',
    dataCopied: 'Data copied to clipboard',
    dataExported: 'Data export successful',
    dataImported: 'Data import successful',
    machineIdChanged: 'Machine code modified successfully',
    machineIdRestored: 'Machine code has been restored'
  },

  // Registration page
  register: {
    title: 'Account registration',
    mode: 'Registration mode',
    manual: 'Manual',
    proxyLabel: 'acting (Optional)',
    proxyPlaceholder: 'socks5://127.0.0.1:1080',
    moApiUrl: 'MoEmail API address',
    moApiKey: 'API key',
    optional: 'Optional',
    outlookAccounts: 'Outlook account',
    outlookFormat: 'Mail----password----clientId----refreshToken',
    outlookPlaceholder: 'user@outlook.com----password----clientId----refreshToken',
    tempmail: 'Self-built mailbox',
    tempMailDomain: 'Self-created domain name',
    tempMailEmail: 'TempMail.Plus username',
    tempMailEmailPlaceholder: 'Username (excluding @mailto.plus）',
    tempMailEpin: 'TempMail.Plus access password',
    tempMailDesc: 'Domain name needs to be configured catch-all forward to TempMail.Plus Email, the system automatically generates a random email prefix for registration',
    gptMail: 'GPTmail',
    gptMailInboxEmail: 'GPTmail Receive email (CF forwarding target)',
    gptMailDomain: 'Self-built domain name pool (CF catch-all Forwarded to receiving email)',
    gptMailPrefix: 'GPTmail Fixed prefix (optional)',
    gptMailBaseURL: 'GPTmail BaseURL(optional)',
    gptMailDesc: 'GPTmail (mail.chatgpt.org.uk) pass CF Email Routing Forward code retrieval: in GPTmail Register a receiving email address,Cloudflare Bundle *@your domain name Forwarded to this mailbox, the system polls GPTmail API Get verification code',
    emailLabel: 'Mail',
    emailPlaceholder: 'your@email.com',
    fullNameLabel: 'Name (Optional)',
    fullNamePlaceholder: 'John Doe',
    submitEmail: 'Submit email',
    otpLabel: 'Verification code',
    otpSentTo: 'Verification code has been sent to',
    submitOtp: 'Submit verification code',
    startRegistration: 'Start registration',
    cancel: 'Cancel',
    newRegistration: 're-register',
    processing: 'Processing...',
    success: 'Registration successful',
    failed: 'Registration failed',
    emailField: 'Mail:',
    passwordField: 'password:',
    importToManager: 'Import manager',
    imported: 'Imported',
    log: 'log',
    logManualInit: 'manual mode: initialization OIDC + Device authorization...',
    logInitDone: 'Initialization completed, Please enter your email',
    logInitFailed: 'Initialization failed:',
    logSubmitEmail: 'Submit email:',
    logOtpSent: 'Verification code sent, Please check your email',
    logFailed: 'fail:',
    logSubmitOtp: 'Submit verification code:',
    logAutoStart: 'automatic mode ({mode}) Start registration...',
    logStartFailed: 'Startup failed:',
    logCancelled: 'Canceled',
    logRegSuccess: 'Registration successful! Mail:',
    logRegFailed: 'Registration failed:',
    logImported: 'The account has been imported into the manager',
    logVerifyFailed: 'Authentication failed:',
    logDirectImport: 'The account has been imported directly (Need to refresh status manually)',
    logImportFailed: 'Import failed:',
    fullNameRandom: 'Name (Optional, Leave blank for random)',
    // manual mode — Parent mailbox / Anonymous email (dot variant)
    parentEmailSection: 'Parent mailbox and anonymous variant',
    parentEmailLabel: 'Home email (receive verification code)',
    parentEmailPlaceholder: 'your-name@gmail.com',
    parentEmailHint: 'Optional. Required when opening the anonymous mailbox; leaving it blank when closing it will be entered manually after initialization.',
    anonymousEmailLabel: 'Random anonymous mailbox (dot variant)',
    anonymousEmailHint: 'Inject from parent mailbox `.` Generate different variants (Gmail/iCloud etc. Ignore the dot), take precedence 1 point → 2 points increment. Each time it is generated, the local account inventory will be queried to avoid duplication.',
    nextVariant: 'next variant',
    dotCount: 'Number of points',
    sameRoot: 'The same root is used',
    anonymousNoParent: 'Please fill in the parent email address first',
    anonymousInvalid: 'The parent email format is invalid',
    anonymousExhausted: 'All dot variants have been used, please change the parent email address',
    logAnonymousNoParent: '[anonymous] The parent email address is empty or has an invalid format and has been cancelled.',
    logAnonymousExhausted: '[anonymous] All dot number variations have been used, please change to a new primary email address',
    logAnonymousGenerated: '[anonymous] Generate variants {email}（{dots} dot number)',
    batchTitle: 'Batch registration',
    batchCount: 'quantity',
    batchInterval: 'interval (Second)',
    batchStart: 'Start batch',
    batchStop: 'Stop batch',
    batchProgress: 'schedule',
    batchSuccess: 'success',
    batchFail: 'fail',
    historyTitle: 'Registration history',
    historyEmpty: 'No registration record yet',
    historyClear: 'Clear history',
    historyTime: 'time',
    historyStatus: 'state',
    historyImport: 'import',
    batchAutoImport: 'Automatic import',
    batchAutoImportDesc: 'After successful registration, it will be automatically verified and imported into the account manager.',
    autoFetchProLink: 'get Pro Subscription link',
    autoFetchProLinkDesc: 'Automatically obtained after successful registration Kiro Pro Subscription link',
    fetchingProLink: 'Getting Pro Subscription link',
    linkCopied: 'Link copied to clipboard',
    batchRetries: 'Number of retries',
    batchConcurrency: 'Number of concurrencies',
    batchRetrying: 'Retrying ({current}/{max})...',
    batchItemSuccess: 'success',
    batchItemFailed: 'fail',
    batchItemRetrying: 'Retrying',
    batchItemImported: 'Imported',
    batchItemImportFailed: 'Import failed',
    batchCompleted: 'Batch registration completed',
    batchStopped: 'Batch stopped {done}/{total}'
  }
}

export default zh
