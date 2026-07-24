// Shared English name database and random generation logic
// Used to generate a more natural and low-duplication "full name" and "email prefix" when registering.
// The name body covers a large number of common English names/The surname and email prefix simulate the naming habits of real users to avoid machine generation at a glance.

export const FIRST_NAMES: readonly string[] = [
  // common male names
  'James', 'Robert', 'John', 'Michael', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Charles',
  'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Paul', 'Andrew', 'Joshua',
  'Kenneth', 'Kevin', 'Brian', 'George', 'Timothy', 'Ronald', 'Edward', 'Jason', 'Jeffrey', 'Ryan',
  'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan', 'Stephen', 'Larry', 'Justin', 'Scott', 'Brandon',
  'Benjamin', 'Samuel', 'Raymond', 'Gregory', 'Frank', 'Alexander', 'Patrick', 'Jack', 'Dennis', 'Jerry',
  'Tyler', 'Aaron', 'Jose', 'Adam', 'Nathan', 'Henry', 'Zachary', 'Douglas', 'Peter', 'Kyle',
  'Noah', 'Ethan', 'Jeremy', 'Walter', 'Christian', 'Keith', 'Roger', 'Terry', 'Austin', 'Sean',
  'Gerald', 'Carl', 'Harold', 'Dylan', 'Arthur', 'Lawrence', 'Jordan', 'Jesse', 'Bryan', 'Billy',
  'Bruce', 'Gabriel', 'Joe', 'Logan', 'Alan', 'Juan', 'Albert', 'Elijah', 'Wayne', 'Randy',
  'Vincent', 'Mason', 'Roy', 'Ralph', 'Russell', 'Bradley', 'Philip', 'Eugene', 'Louis', 'Caleb',
  'Hunter', 'Connor', 'Aidan', 'Ian', 'Cameron', 'Owen', 'Luke', 'Isaac', 'Wesley', 'Carlos',
  'Miguel', 'Antonio', 'Victor', 'Marcus', 'Travis', 'Cole', 'Blake', 'Shawn', 'Trevor', 'Spencer',
  'Devin', 'Colin', 'Drew', 'Grant', 'Theodore', 'Oliver', 'Liam', 'Lucas', 'Nathaniel', 'Adrian',
  'Dean', 'Derek', 'Evan', 'Fred', 'Harry', 'Hayden', 'Leo', 'Brad',
  // common female names
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Elizabeth', 'Susan', 'Jessica', 'Sarah', 'Karen',
  'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra', 'Ashley', 'Dorothy', 'Kimberly', 'Emily', 'Donna',
  'Michelle', 'Carol', 'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Sharon', 'Laura', 'Cynthia',
  'Kathleen', 'Amy', 'Angela', 'Shirley', 'Anna', 'Brenda', 'Pamela', 'Emma', 'Nicole', 'Helen',
  'Samantha', 'Katherine', 'Christine', 'Debra', 'Rachel', 'Carolyn', 'Janet', 'Catherine', 'Maria', 'Heather',
  'Diane', 'Olivia', 'Julie', 'Joyce', 'Victoria', 'Kelly', 'Christina', 'Joan', 'Evelyn', 'Lauren',
  'Judith', 'Megan', 'Cheryl', 'Andrea', 'Hannah', 'Martha', 'Jacqueline', 'Frances', 'Gloria', 'Ann',
  'Teresa', 'Kathryn', 'Sophia', 'Madison', 'Abigail', 'Grace', 'Natalie', 'Brittany', 'Danielle', 'Sara',
  'Alexis', 'Isabella', 'Mia', 'Charlotte', 'Amelia', 'Ava', 'Chloe', 'Ella', 'Avery', 'Sofia',
  'Aria', 'Scarlett', 'Allison', 'Audrey', 'Brooke', 'Claire', 'Lily', 'Zoe', 'Leah', 'Hailey',
  'Paige', 'Vanessa', 'Alice', 'Amber', 'Aubrey', 'Beverly', 'Dawn', 'Diana', 'Holly', 'Julia',
  'Kayla', 'Lucy', 'Lydia', 'Molly', 'Nora', 'Riley', 'Tammy', 'Tina', 'Valerie', 'Wendy'
]

export const LAST_NAMES: readonly string[] = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
  'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
  'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts',
  'Gomez', 'Phillips', 'Evans', 'Turner', 'Diaz', 'Parker', 'Cruz', 'Edwards', 'Collins', 'Reyes',
  'Stewart', 'Morris', 'Morales', 'Murphy', 'Cook', 'Rogers', 'Gutierrez', 'Ortiz', 'Morgan', 'Cooper',
  'Peterson', 'Bailey', 'Reed', 'Kelly', 'Howard', 'Ramos', 'Kim', 'Cox', 'Ward', 'Richardson',
  'Watson', 'Brooks', 'Chavez', 'Wood', 'James', 'Bennett', 'Gray', 'Mendoza', 'Ruiz', 'Hughes',
  'Price', 'Alvarez', 'Castillo', 'Sanders', 'Patel', 'Myers', 'Long', 'Ross', 'Foster', 'Jimenez',
  'Powell', 'Jenkins', 'Perry', 'Russell', 'Sullivan', 'Bell', 'Coleman', 'Butler', 'Henderson', 'Barnes',
  'Gonzales', 'Fisher', 'Vasquez', 'Simmons', 'Romero', 'Jordan', 'Patterson', 'Alexander', 'Hamilton', 'Graham',
  'Reynolds', 'Griffin', 'Wallace', 'Moreno', 'West', 'Cole', 'Hayes', 'Bryant', 'Herrera', 'Gibson',
  'Ellis', 'Tran', 'Medina', 'Aguilar', 'Stevens', 'Murray', 'Ford', 'Castro', 'Marshall', 'Owens',
  'Harrison', 'Fernandez', 'Mcdonald', 'Woods', 'Washington', 'Kennedy', 'Wells', 'Vargas', 'Henry', 'Chen',
  'Freeman', 'Webb', 'Tucker', 'Guzman', 'Burns', 'Crawford', 'Olson', 'Simpson', 'Porter', 'Hunter',
  'Gordon', 'Mendez', 'Silva', 'Shaw', 'Snyder', 'Mason', 'Dixon', 'Munoz', 'Hunt', 'Hicks',
  'Holmes', 'Palmer', 'Wagner', 'Black', 'Robertson', 'Boyd', 'Rose', 'Stone', 'Salazar', 'Fox',
  'Warren', 'Mills', 'Meyer', 'Rice', 'Schmidt', 'Garza', 'Daniels', 'Ferguson', 'Nichols', 'Stephens',
  'Soto', 'Weaver', 'Ryan', 'Gardner', 'Payne', 'Grant', 'Dunn', 'Kelley', 'Spencer', 'Hawkins',
  'Arnold', 'Pierce', 'Vazquez', 'Hansen', 'Peters', 'Santos', 'Hart'
]

// Common English nicknames (lowercase), only used for email prefixes, simulating random names given by real people
export const NICKNAMES: readonly string[] = [
  'mike', 'dave', 'chris', 'alex', 'sam', 'jess', 'kate', 'tom', 'nick', 'joe',
  'dan', 'matt', 'rob', 'will', 'ben', 'jen', 'liz', 'beth', 'andy', 'tony',
  'jim', 'bob', 'rick', 'steve', 'greg', 'ken', 'charlie', 'jack', 'jake', 'max',
  'gabe', 'nate', 'zach', 'josh', 'tim', 'pat', 'vince', 'leo', 'ray', 'gene',
  'marty', 'phil', 'pete', 'randy', 'russ', 'abby', 'allie', 'becky', 'bella', 'cassie',
  'cathy', 'debbie', 'ellie', 'gabby', 'gracie', 'izzy', 'josie', 'katie', 'lucy', 'maggie',
  'mandy', 'meg', 'mel', 'millie', 'nina', 'patty', 'penny', 'rosie', 'sadie', 'sally',
  'sandy', 'sue', 'tess', 'val', 'vicky', 'wendy'
]

function randInt(max: number): number {
  return Math.floor(Math.random() * max)
}

function pick<T>(arr: readonly T[]): T {
  return arr[randInt(arr.length)]
}

// A small number of random lowercase letter suffixes (1-2 ), only used to supplement uniqueness when combining basic names
function randomLetters(): string {
  const n = 1 + randInt(2)
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + randInt(26))
  return s
}

// Random full name (used to register display name), occasionally with middle initial to further reduce duplication rates
export function randomFullName(): string {
  const first = pick(FIRST_NAMES)
  const last = pick(LAST_NAMES)
  if (Math.random() < 0.18) {
    const mid = String.fromCharCode(65 + randInt(26)) // A-Z
    return `${first} ${mid}. ${last}`
  }
  return `${first} ${last}`
}

// Random email prefix: mainly a combination of real name components (middle name, double surname, etc., no numbers, no garbled characters, most like a real person),
// A small amount of basic combination supplement 1-2 The random letters are guaranteed to be unique, and the overall low repetition and natural
export function randomEmailPrefix(): string {
  const first = pick(FIRST_NAMES).toLowerCase()
  const last = pick(LAST_NAMES).toLowerCase()
  const middle = pick(FIRST_NAMES).toLowerCase()
  const last2 = pick(LAST_NAMES).toLowerCase()
  const nick = pick(NICKNAMES)
  const fi = first.charAt(0)
  const mi = middle.charAt(0)
  const li = last.charAt(0)

  const r = Math.random()

  // about 72%: A multi-component combination of real names, highly unique and the most natural
  if (r < 0.72) {
    const s = pick(['.', '.', '.', '_'])
    return pick([
      `${first}${s}${middle}${s}${last}`, // john.michael.smith
      `${first}${s}${mi}${s}${last}`,     // john.m.smith
      `${first}${mi}${s}${last}`,         // johnm.smith
      `${first}${s}${last}${s}${last2}`,  // john.smith.brown(double surname)
      `${fi}${s}${middle}${s}${last}`,    // j.michael.smith
      `${first}${s}${middle}`,            // john.michael
      `${middle}${s}${last}`,             // michael.smith
      `${nick}${s}${middle}${s}${last}`   // mike.john.smith
    ])
  }

  // about 18%:Basic name combination + 1-2 random letters, taking into account nature and uniqueness
  if (r < 0.9) {
    const base = pick([
      `${first}${last}`,
      `${first}.${last}`,
      `${fi}${last}`,
      `${first}${li}`,
      `${nick}${last}`,
      `${last}${fi}`
    ])
    return `${base}${randomLetters()}`
  }

  // about 10%: Pure name combination (without any suffix), retaining a few simplest writing methods
  return pick([
    `${first}.${last}`,
    `${first}${last}`,
    `${nick}.${last}`,
    `${first}.${middle}.${last}`
  ])
}
