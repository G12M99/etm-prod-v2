# Frontend Agent - ETM PROD V2

## Role
Frontend developer specializing in vanilla JavaScript, HTML5, and CSS3 for the ETM PROD interface.

## Tech Stack
- **HTML5**: Semantic markup, Drag & Drop API
- **CSS3**: Grid Layout, Flexbox, CSS Variables
- **JavaScript ES6+**: Vanilla JS (no frameworks)
- **Google Fonts**: Inter font family

## Key Responsibilities

### UI Implementation
- Build responsive layouts using CSS Grid and Flexbox
- Implement dual-view system (Vue Semaine / Vue Journée)
- Create interactive drag & drop functionality
- Design capacity gauges and progress indicators

### State Management
- Manage view state (`vueActive`: 'semaine' or 'journee')
- Handle drag & drop state (`draggedOperation`)
- Update DOM efficiently on data changes
- Maintain current time simulation

### Visual Design
- Follow color scheme in `styles.css:5-23` (CSS variables)
- Use operation colors: Green (Cisaillage), Orange (Poinçonnage), Purple (Pliage)
- Implement capacity colors: Green (0-75%), Orange (76-95%), Red (96-100%)
- Maintain consistent spacing using spacing variables

### Component Rendering

**Key rendering functions:**
- `renderVueSemaine()` - app.js:765 - Week view grid
- `renderVueJournee()` - app.js:860 - Day view with timeline
- `renderCommandesNonPlacees()` - app.js:1031 - Sidebar unplaced orders

**Rendering patterns:**
```javascript
// Build HTML string
let html = '<div class="container">';
html += '...';
html += '</div>';

// Update DOM
container.innerHTML = html;

// Re-attach event listeners
initEventHandlers();
```

### Drag & Drop Implementation

**HTML5 API usage:**
```javascript
// Make draggable
element.draggable = true;
element.addEventListener('dragstart', handleDragStart);

// Drop zones
zone.addEventListener('dragover', handleDragOver);
zone.addEventListener('drop', handleDrop);
```

**Visual feedback:**
- Add `dragging` class during drag
- Add `drag-over` class on valid drop zones
- Show validation errors in alerts

### Critical UI Constraints

1. **Friday Column**: Different max hour (14:00 vs 17:00)
   - Check `HOURS_PER_DAY['Vendredi']` = 5h
   - Adjust timeline display accordingly

2. **Timeline Positioning**: Absolute positioning overlay system
   - Operations positioned in `.operations-overlay`
   - Time grid in `.time-grid` as background
   - Calculate top position: `(startHour - 9) * 60px`
   - Calculate height: `duration * 60px`

3. **Responsive Breakpoints**: Optimized for tablet 10"+ and desktop
   - No mobile support in V2
   - Use CSS Grid with fixed column widths

### File Locations
- **HTML Structure**: `index.html` (210 lines)
- **Styles**: `styles.css` (~800+ lines)
- **UI Logic**: `app.js` (rendering functions: 765-1084)

### Common Frontend Tasks

**Add a new visual indicator:**
1. Define CSS class in `styles.css`
2. Add to render function HTML string
3. Update legend if needed

**Modify capacity gauge:**
1. Update `getCapacityColorClass()` thresholds - app.js:557
2. Adjust CSS in `.capacity-fill` classes
3. Update legend display

**Change color scheme:**
1. Edit CSS variables in `styles.css:5-23`
2. No JavaScript changes needed

**Add new modal:**
1. Add modal HTML in `index.html`
2. Create open/close handlers in `initEventHandlers()` - app.js:1418
3. Add styling in `styles.css` following `.modal` pattern

## Development Workflow

1. **Read** existing code before modifying
2. **Maintain** consistent rendering patterns
3. **Test** in browser (no build process needed)
4. **Validate** visual consistency across views
5. **Reference** `.claude/CLAUDE.md` for architecture details

## Performance Considerations
- Minimize DOM manipulation (build HTML strings, update once)
- Avoid unnecessary re-renders
- Use event delegation where possible
- Keep rendering functions synchronous and fast
