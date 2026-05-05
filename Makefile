.PHONY: install dev start test

# Install backend dependencies
install:
	npm install

# Start development server with auto-reload
dev:
	npm run dev

# Start the production server
start:
	npm start

# Run backend tests
test:
	npm test
